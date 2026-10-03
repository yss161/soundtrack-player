'''
Function:
    声轨 Soundtrack —— 基于 musicdl 的现代化 Web 音乐播放器（后端）。

    musicdl 的搜索慢在：每条结果都要实时解析真正的音频直链（多次网络往返），
    直接同步等待 search() 会让界面卡住十几到几十秒。本服务绝不阻塞：
    - 逐条流式返回: 直接驱动 musicdl 的 _search，监听它内部边解析边追加的结果列表，
      每解析出一首立即通过 SSE 推给前端；
    - 多源并发: 每个音乐源独立线程，快源先出，慢源后到，互不阻塞；
    - 看门狗超时: 任何源卡住超过 PER_SOURCE_TIMEOUT 秒即被丢弃标记，绝不拖垮界面；
    - 即点即放: 搜索时已解析直链，播放走后端代理（支持 Range 拖动进度）；
    - 下载实时进度: 分块下载，实时推送已下载字节数与速度。

Usage:
    py -3.14 app.py   →   http://127.0.0.1:5000
Author:
    Built on top of CharlesPikachu/musicdl.
'''
import os
import re
import sys
import time
import uuid
import json
import queue
import socket
import inspect
import tempfile
import mimetypes
import ipaddress
import subprocess
import threading
import requests
from contextlib import suppress
from urllib.parse import quote
from urllib.parse import urlparse
from flask import Flask, request, Response, jsonify, stream_with_context

# musicdl 源码查找顺序（找到含 musicdl/__init__.py 的目录即加入 sys.path 最前）:
#   1. gui/vendor/                 —— 推荐的随包分发位置
#   2. gui/musicdl-master/         —— GitHub 下载的源码 zip 直接解压进 gui 目录
#   3. gui 的上级目录              —— 仓库开发模式（gui 位于 musicdl 仓库内）
#   4. 上级目录旁的 musicdl-master/ —— zip 解压在 gui 旁边
# 都找不到时回落到 site-packages（不推荐，PyPI 发行版 API 较旧且部分源已失效）。
def _locate_musicdl_root():
    here = os.path.dirname(os.path.abspath(__file__))
    parent = os.path.dirname(here)
    for candidate in (
        os.path.join(here, 'vendor'),
        os.path.join(here, 'musicdl-master'),
        parent,
        os.path.join(parent, 'musicdl-master'),
    ):
        if os.path.isfile(os.path.join(candidate, 'musicdl', '__init__.py')):
            return candidate
    return None


_musicdl_root = _locate_musicdl_root()
if _musicdl_root and _musicdl_root not in sys.path:
    sys.path.insert(0, _musicdl_root)

from musicdl import musicdl


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.realpath(os.path.join(HERE, 'static'))
DOWNLOAD_DIR = os.path.realpath(os.path.join(HERE, 'downloads'))
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

# 启动时清理上次运行残留的孤儿临时文件（如进程被杀时正在下载的 .part）
for _stale in os.listdir(DOWNLOAD_DIR):
    if _stale.startswith('dl_') and _stale.endswith('.part'):
        with suppress(OSError):
            os.unlink(os.path.join(DOWNLOAD_DIR, _stale))

# 暴露给界面的音源。默认只开咪咕（稳定、快），其余在顶栏一键启用。
# color 为各平台品牌主题色，用于界面区分（咪咕蓝/网易云红/酷我金/QQ绿/酷狗蓝/千千紫/GD粉）。
SUPPORTED_SOURCES = {
    'MiguMusicClient':    {'label': '咪咕音乐', 'short': 'Migu',    'default': True,  'color': '#00a9e0'},
    'NeteaseMusicClient': {'label': '网易云音乐', 'short': 'Netease', 'default': False, 'color': '#ec4141'},
    'KuwoMusicClient':    {'label': '酷我音乐', 'short': 'Kuwo',    'default': False, 'color': '#ffb02e'},
    'QQMusicClient':      {'label': 'QQ音乐',   'short': 'QQ',      'default': False, 'color': '#31c27c'},
    'KugouMusicClient':   {'label': '酷狗音乐', 'short': 'Kugou',   'default': False, 'color': '#3d7eff'},
    'QianqianMusicClient': {'label': '千千音乐', 'short': 'Qianqian', 'default': False, 'color': '#9a6bff'},
    'GDStudioMusicClient': {'label': 'GD聚合',  'short': 'GDStudio', 'default': False, 'color': '#ff6d9d'},
}
SOURCE_ORDER = ['NeteaseMusicClient', 'KuwoMusicClient', 'QQMusicClient', 'KugouMusicClient', 'QianqianMusicClient', 'MiguMusicClient', 'GDStudioMusicClient']
SOURCE_SHORT_WHITELIST = frozenset(v['short'] for v in SUPPORTED_SOURCES.values())

SEARCH_SIZE_PER_SOURCE = 8       # 每个源尝试解析的歌曲数（越大越慢）
PER_SOURCE_TIMEOUT = 35          # 单源看门狗超时秒数
RESULT_EXT_TO_MIME = {
    'mp3': 'audio/mpeg', 'flac': 'audio/flac', 'wav': 'audio/wav',
    'm4a': 'audio/mp4', 'aac': 'audio/aac', 'ape': 'audio/x-ape', 'ogg': 'audio/ogg',
}


# ---------------------------------------------------------------------------
# 上游请求防护: SSRF 校验（协议白名单 + 阻断私网/环回/链路本地目标）
# ---------------------------------------------------------------------------
class UnsafeUpstreamError(Exception):
    pass


def _ip_unsafe(ip) -> bool:
    return bool(ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified)


def _host_unsafe_literal(hostname: str) -> bool:
    '''hostname 若是 IP 字面量，判断其是否属于内网/保留地址（不做 DNS 解析）。'''
    try:
        return _ip_unsafe(ipaddress.ip_address(hostname.split('%')[0]))
    except ValueError:
        return False


def _validate_public_http_url(url: str, resolve_dns: bool = True) -> bool:
    '''仅允许 http(s)，且目标主机（含 DNS 解析结果）不得为内网/环回/链路本地地址。'''
    try:
        parsed = urlparse(str(url))
    except Exception:
        return False
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        return False
    host = parsed.hostname.lower()
    if host in {'localhost', 'localhost.localdomain', 'metadata.google.internal', 'instance-data'}:
        return False
    if _host_unsafe_literal(host):
        return False
    if resolve_dns and not host.replace('.', '').replace(':', '').isdigit():
        try:
            infos = socket.getaddrinfo(host, None)
        except Exception:
            return False
        for info in infos:
            if _host_unsafe_literal(info[4][0]):
                return False
    return True


def _fetch_upstream(url: str, **kwargs):
    '''带 SSRF 防护与 TLS 校验的上游请求；重定向后的最终地址同样校验。'''
    if not _validate_public_http_url(url, resolve_dns=True):
        raise UnsafeUpstreamError(f'blocked url: {url}')
    kwargs.setdefault('timeout', (10, 30))
    resp = requests.get(url, verify=True, **kwargs)
    final_host = (urlparse(resp.url or url).hostname or '').lower()
    if final_host in {'localhost', 'metadata.google.internal'} or _host_unsafe_literal(final_host):
        resp.close()
        raise UnsafeUpstreamError(f'blocked redirect: {resp.url}')
    return resp


# ---------------------------------------------------------------------------
# 本地文件安全下发: realpath 归一化后必须仍在 allowed_root 内，分块流式读取
# ---------------------------------------------------------------------------
def _resolve_inside(path: str, allowed_root: str):
    '''规范化 path，若逃出 allowed_root 或不存在则返回 None（防穿越与符号链接逃逸）。'''
    try:
        root = os.path.realpath(allowed_root)
        real = os.path.realpath(path)
        if real == root or real.startswith(root + os.sep):
            return real if os.path.isfile(real) else None
    except Exception:
        pass
    return None


def _serve_static(allowed_root: str, filename: str, as_attachment: bool = False):
    '''按常量文件名下发 allowed_root 内的文件（realpath 校验 + 分块读取）。'''
    safe_path = _resolve_inside(os.path.join(allowed_root, filename), allowed_root)
    if not safe_path:
        return Response('not found', status=404)
    mimetype = mimetypes.guess_type(safe_path)[0] or 'application/octet-stream'
    headers = {'Content-Length': str(os.path.getsize(safe_path)), 'Cache-Control': 'no-cache'}
    if as_attachment:
        headers['Content-Disposition'] = f"attachment; filename*=UTF-8''{quote(filename)}"

    def generate():
        with open(safe_path, 'rb') as fp:
            while True:
                chunk = fp.read(262144)
                if not chunk:
                    break
                yield chunk

    return Response(stream_with_context(generate()), mimetype=mimetype, headers=headers)


# ---------------------------------------------------------------------------
# musicdl 客户端管理（单个 MusicClient，懒加载，持有全部音源）
# ---------------------------------------------------------------------------
class ClientManager:
    def __init__(self):
        self._lock = threading.Lock()
        self._mc = None

    def _build(self):
        cfg = {s: {'search_size_per_source': 3 if s == 'GDStudioMusicClient' else SEARCH_SIZE_PER_SOURCE,
                   'disable_print': True}
               for s in SUPPORTED_SOURCES}
        return musicdl.MusicClient(music_sources=list(SUPPORTED_SOURCES.keys()),
                                   init_music_clients_cfg=cfg)

    def client(self, source):
        with self._lock:
            if self._mc is None:
                self._mc = self._build()
        return self._mc.music_clients[source]


MANAGER = ClientManager()


# ---------------------------------------------------------------------------
# 内存注册表: token → 已解析曲目（播放/下载无需重新搜索）
# ---------------------------------------------------------------------------
class TrackRegistry:
    def __init__(self):
        self._lock = threading.Lock()
        self._tracks = {}

    def add(self, song_info, source):
        token = uuid.uuid4().hex[:16]
        client = MANAGER.client(source)
        headers = dict(getattr(client, 'default_download_headers', {}) or {})
        headers.update(dict(getattr(song_info, 'default_download_headers', {}) or {}))
        cookies = dict(getattr(client, 'default_download_cookies', {}) or {})
        cookies.update(dict(getattr(song_info, 'default_download_cookies', {}) or {}))
        with self._lock:
            self._tracks[token] = {'song_info': song_info, 'source': source, 'headers': headers, 'cookies': cookies}
        return token

    def get(self, token):
        with self._lock:
            return self._tracks.get(token)


REGISTRY = TrackRegistry()


class _NullProgress:
    '''rich.Progress 的空替身，让 _search 在无终端环境下安静运行。'''
    def add_task(self, *a, **k): return 0
    def update(self, *a, **k): pass
    def advance(self, *a, **k): pass
    def __getattr__(self, _): return lambda *a, **k: None


def _track_payload(song_info, token):
    '''把 SongInfo 序列化成前端需要的最小 JSON。'''
    s = lambda v: '' if v is None else str(v)
    ext = s(song_info.ext).lower().lstrip('.')
    return {
        'token': token,
        'source': SUPPORTED_SOURCES.get(s(song_info.source), {}).get('short', s(song_info.source)),
        'source_label': SUPPORTED_SOURCES.get(s(song_info.source), {}).get('label', s(song_info.source)),
        'song_name': s(song_info.song_name) or '未知曲目',
        'singers': s(song_info.singers) or '未知艺人',
        'album': s(song_info.album),
        'ext': ext,
        'file_size': s(song_info.file_size),
        'duration': s(song_info.duration),
        'cover_url': s(song_info.cover_url),
        'has_lyric': bool(getattr(song_info, 'lyric', None)),
        'lossless': ext in {'flac', 'wav', 'ape', 'alac'},
    }


# ---------------------------------------------------------------------------
# 流式搜索: 驱动 musicdl 逐条解析，解析出一条推一条
# ---------------------------------------------------------------------------
def search_stream(keyword, sources):
    '''SSE 生成器。所有源并发，每条结果解析完成立刻推送。'''
    out = queue.Queue()
    seen_identifiers = set()
    seen_lock = threading.Lock()
    active = {'n': 0}

    def emit(event, data):
        out.put(f'event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n')

    def run_source(source):
        try:
            client = MANAGER.client(source)
            progress = _NullProgress()
            try:
                search_urls = client._constructsearchurls(keyword=keyword, rule={}, request_overrides={})
            except Exception as err:
                emit('source_error', {'source': source, 'message': str(err)})
                return
            buckets = [[] for _ in search_urls]
            threads = []
            for i, url in enumerate(search_urls):
                t = threading.Thread(target=_safe_search, args=(client, keyword, url, buckets[i], progress), daemon=True)
                t.start()
                threads.append(t)
            deadline = time.time() + PER_SOURCE_TIMEOUT
            cursors = [0] * len(buckets)
            count = 0
            while True:
                count += _drain(buckets, cursors, source, seen_identifiers, seen_lock, emit)
                alive = any(t.is_alive() for t in threads)
                if not alive or time.time() > deadline:
                    break
                time.sleep(0.12)
            count += _drain(buckets, cursors, source, seen_identifiers, seen_lock, emit)
            timed_out = any(t.is_alive() for t in threads)
            emit('source_done', {'source': source, 'count': count, 'timed_out': timed_out})
        except Exception as err:
            emit('source_error', {'source': source, 'message': str(err)})
        finally:
            with seen_lock:
                active['n'] -= 1
                if active['n'] == 0:
                    out.put(None)  # 哨兵: 全部源结束

    valid = [s for s in SOURCE_ORDER if s in sources]
    if not valid:
        yield 'event: done\ndata: {"count": 0}\n\n'
        return

    active['n'] = len(valid)
    for source in valid:
        emit('source_start', {'source': source, 'label': SUPPORTED_SOURCES[source]['label']})
        threading.Thread(target=run_source, args=(source,), daemon=True).start()

    total = 0
    while True:
        msg = out.get()
        if msg is None:
            break
        if msg.startswith('event: result'):
            total += 1
        yield msg
    yield f'event: done\ndata: {{"count": {total}}}\n\n'


def _safe_search(client, keyword, url, bucket, progress):
    '''兼容两种 musicdl 版本的 _search 签名（仓库版无 progress_id，PyPI 发行版有）。'''
    try:
        kwargs = {'keyword': keyword, 'search_url': url, 'request_overrides': {}, 'song_infos': bucket, 'progress': progress}
        params = inspect.signature(client._search).parameters
        if 'progress_id' in params:
            kwargs['progress_id'] = 0
        client._search(**kwargs)
    except Exception:
        pass


def _drain(buckets, cursors, source, seen, lock, emit):
    '''推送所有分页桶里新出现的曲目；按 identifier 去重。'''
    emitted = 0
    for i, bucket in enumerate(buckets):
        while cursors[i] < len(bucket):
            song_info = bucket[cursors[i]]
            cursors[i] += 1
            try:
                ident = str(getattr(song_info, 'identifier', None))
                with lock:
                    if ident in seen:
                        continue
                    seen.add(ident)
                token = REGISTRY.add(song_info, source)
                emit('result', _track_payload(song_info, token))
                emitted += 1
            except Exception:
                continue
    return emitted


# ---------------------------------------------------------------------------
# 下载: 分块 + 实时进度 + 可终止/可删除/可打开目录
# ---------------------------------------------------------------------------
DOWNLOADS = {}
DL_LOCK = threading.Lock()


class DownloadCancelled(Exception):
    '''用户主动终止下载。'''


def _safe_name(name):
    '''清洗文件名: 去除路径分隔符/控制符，去首尾点号与空白，限长。'''
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', str(name or 'track')).strip(' .')
    return (name[:120] or 'track')


def _cleanup_tmp(tmp_path):
    '''删除未完成的临时文件（mkstemp 生成的服务器侧路径）。'''
    if tmp_path:
        with suppress(OSError):
            os.unlink(tmp_path)


def _validated_download_file(rec):
    '''校验下载记录中的文件路径: 子目录白名单 + 文件名净化 + realpath 锁定在 DOWNLOAD_DIR。
    通过返回绝对路径，否则返回 None。'''
    subdir = rec.get('subdir') or ''
    fname = _safe_name(str(rec.get('name') or ''))
    if (not fname) or fname in {'.', '..'} or ('/' in fname) or ('\\' in fname) or ('..' in fname):
        return None
    if subdir not in SOURCE_SHORT_WHITELIST:
        return None
    return _resolve_inside(os.path.join(DOWNLOAD_DIR, subdir, fname), DOWNLOAD_DIR)


def _download_target_path(subdir: str, song_name: str, singers: str, ext: str):
    '''构造并校验下载落盘路径。返回 realpath 后的绝对路径，校验失败返回 None。
    - 子目录必须命中音源白名单；
    - 文件名净化: 去路径分隔符/控制符，并拒绝残留的路径成分（../ 等）；
    - realpath 归一化后必须仍在 DOWNLOAD_DIR 内。'''
    if subdir not in SOURCE_SHORT_WHITELIST:
        return None
    fname = f"{_safe_name(song_name)} - {_safe_name(singers)}.{_safe_name(ext)}"
    if (not fname) or fname in {'.', '..'} or ('/' in fname) or ('\\' in fname) or ('..' in fname):
        fname = 'track.mp3'
    real_dir = os.path.realpath(os.path.join(DOWNLOAD_DIR, subdir))
    if not real_dir.startswith(DOWNLOAD_DIR + os.sep):
        return None
    os.makedirs(real_dir, exist_ok=True)
    real_final = os.path.realpath(os.path.join(real_dir, fname))
    if not real_final.startswith(DOWNLOAD_DIR + os.sep):
        return None
    return real_final


def run_download(download_id, token, cancel_event):
    entry = REGISTRY.get(token)
    if not entry:
        _set_dl(download_id, status='error', message='曲目已过期，请重新搜索')
        return
    song = entry['song_info']
    url = getattr(song, 'download_url', None)
    if not isinstance(url, str) or not url.startswith('http'):
        _set_dl(download_id, status='error', message='该曲目没有可用的下载地址')
        return
    source = entry['source']
    subdir = SUPPORTED_SOURCES.get(source, {}).get('short', source)
    ext = (str(song.ext) or 'mp3').lstrip('.')
    path = _download_target_path(subdir, str(song.song_name), str(song.singers), ext)
    if path is None:
        _set_dl(download_id, status='error', message='非法的保存路径')
        return
    # 临时文件由 tempfile.mkstemp 在 DOWNLOAD_DIR 内安全创建（文件名由系统生成），
    # 写入句柄直接来自返回的 fd，不经过任何外部可控路径
    tmp_fd, tmp_path = tempfile.mkstemp(suffix='.part', prefix='dl_', dir=DOWNLOAD_DIR)
    # tmp 路径记入下载记录，仅用于终止时清理
    _set_dl(download_id, tmp=tmp_path)
    try:
        with _fetch_upstream(url, headers=entry['headers'], cookies=entry['cookies'], stream=True) as resp:
            # 存下响应引用，终止时可立刻断流
            _set_dl(download_id, resp=resp)
            resp.raise_for_status()
            total = int(float(resp.headers.get('Content-Length', 0) or 0))
            if total <= 0:
                total = int(getattr(song, 'file_size_bytes', 0) or 0)
            _set_dl(download_id, status='downloading', total=total, downloaded=0, name=os.path.basename(path), subdir=subdir)
            done, last, last_bytes = 0, time.time(), 0
            with os.fdopen(tmp_fd, 'wb') as fp:
                tmp_fd = None
                for chunk in resp.iter_content(chunk_size=256 * 1024):
                    if cancel_event.is_set():
                        raise DownloadCancelled()
                    if not chunk:
                        continue
                    fp.write(chunk)
                    done += len(chunk)
                    now = time.time()
                    if now - last >= 0.25:
                        speed = (done - last_bytes) / (now - last)
                        _set_dl(download_id, downloaded=done, total=total, speed=speed)
                        last, last_bytes = now, done
            os.replace(tmp_path, path)
            tmp_path = None
            _set_dl(download_id, status='done', downloaded=done, total=total or done, speed=0, name=os.path.basename(path), subdir=subdir)
    except DownloadCancelled:
        _set_dl(download_id, status='cancelled', speed=0, message='已取消')
    except UnsafeUpstreamError as err:
        _set_dl(download_id, status='error', message=f'下载地址被安全策略拦截 ({err})')
    except Exception as err:
        # 终止会关闭底层连接从而在读取处抛错 —— 此时应标记为已取消而非错误
        cancelled = cancel_event.is_set()
        _set_dl(download_id, status='cancelled' if cancelled else 'error', speed=0,
                message='已取消' if cancelled else str(err))
    finally:
        if tmp_fd is not None:
            with suppress_oserror():
                os.close(tmp_fd)
        if tmp_path is not None:
            with suppress_oserror():
                os.unlink(tmp_path)


class suppress_oserror:
    '''忽略清理阶段的 OS 错误。'''
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        return exc_type is not None and issubclass(exc_type, OSError)


def _set_dl(download_id, **fields):
    with DL_LOCK:
        rec = DOWNLOADS.setdefault(download_id, {})
        rec.update(fields)
        rec['updated'] = time.time()


def _get_dl(download_id):
    with DL_LOCK:
        return dict(DOWNLOADS.get(download_id, {}))


# ---------------------------------------------------------------------------
# Flask 应用 + 路由
# ---------------------------------------------------------------------------
app = Flask(__name__, static_folder=None)


@app.route('/')
def index():
    return _serve_static(STATIC_DIR, 'index.html')


@app.route('/static/<path:fname>')
def static_files(fname):
    '''静态资源白名单: 命中常量才下发，其余一律 404（无任何动态路径拼接）。'''
    if fname == 'style.css':
        return _serve_static(STATIC_DIR, 'style.css')
    if fname == 'app.js':
        return _serve_static(STATIC_DIR, 'app.js')
    return _serve_static(STATIC_DIR, 'index.html') if fname == 'index.html' else Response('not found', status=404)


@app.route('/api/sources')
def api_sources():
    return jsonify([
        {'id': sid, 'label': SUPPORTED_SOURCES[sid]['label'],
         'short': SUPPORTED_SOURCES[sid]['short'], 'default': SUPPORTED_SOURCES[sid]['default'],
         'color': SUPPORTED_SOURCES[sid].get('color', '#7c6cff')}
        for sid in SOURCE_ORDER
    ])


@app.route('/api/search')
def api_search():
    keyword = (request.args.get('q') or '').strip()
    raw_sources = (request.args.get('sources') or '').strip()
    sources = [s for s in raw_sources.split(',') if s in SUPPORTED_SOURCES]
    if not sources:
        sources = [s for s in SOURCE_ORDER if SUPPORTED_SOURCES[s]['default']]
    if not keyword:
        return jsonify({'error': '请输入搜索关键词'}), 400

    @stream_with_context
    def generate():
        yield 'retry: 10000\n\n'
        for msg in search_stream(keyword, sources):
            yield msg

    return Response(generate(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.route('/api/stream/<token>')
def api_stream(token):
    '''代理上游音频并支持 Range，让 <audio> 可以拖动进度。'''
    entry = REGISTRY.get(token)
    if not entry:
        return Response('expired', status=404)
    song = entry['song_info']
    url = getattr(song, 'download_url', None)
    if not isinstance(url, str) or not url.startswith('http'):
        return Response('no audio url', status=404)
    upstream_headers = dict(entry['headers'])
    range_header = request.headers.get('Range')
    if range_header:
        upstream_headers['Range'] = range_header
    try:
        up = _fetch_upstream(url, headers=upstream_headers, cookies=entry['cookies'], stream=True)
    except UnsafeUpstreamError:
        return Response('blocked upstream url', status=403)
    except Exception as err:
        return Response(f'upstream error: {err}', status=502)
    ext = (str(song.ext) or 'mp3').lstrip('.').lower()
    resp_headers = {
        'Content-Type': RESULT_EXT_TO_MIME.get(ext, 'application/octet-stream'),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
    }
    for h in ('Content-Length', 'Content-Range'):
        if h in up.headers:
            resp_headers[h] = up.headers[h]

    def generate():
        try:
            for chunk in up.iter_content(chunk_size=64 * 1024):
                if chunk:
                    yield chunk
        finally:
            up.close()

    return Response(stream_with_context(generate()), status=up.status_code, headers=resp_headers)


@app.route('/api/cover/<token>')
def api_cover(token):
    '''代理封面（部分图床有防盗链/需 Referer）。'''
    entry = REGISTRY.get(token)
    if not entry:
        return Response('', status=404)
    url = getattr(entry['song_info'], 'cover_url', None)
    if not isinstance(url, str) or not url.startswith('http'):
        return Response('', status=404)
    try:
        up = _fetch_upstream(url, headers={'User-Agent': entry['headers'].get('User-Agent', 'Mozilla/5.0')}, timeout=(10, 20))
        return Response(up.content, status=up.status_code,
                        headers={'Content-Type': up.headers.get('Content-Type', 'image/jpeg'),
                                 'Cache-Control': 'public, max-age=86400'})
    except UnsafeUpstreamError:
        return Response('', status=403)
    except Exception:
        return Response('', status=502)


@app.route('/api/lyric/<token>')
def api_lyric(token):
    entry = REGISTRY.get(token)
    if not entry:
        return jsonify({'lyric': ''})
    return jsonify({'lyric': getattr(entry['song_info'], 'lyric', '') or ''})


@app.route('/api/download', methods=['POST'])
def api_download():
    data = request.get_json(force=True, silent=True) or {}
    token = data.get('token')
    entry = REGISTRY.get(token)
    if not entry:
        return jsonify({'error': '曲目已过期，请重新搜索'}), 404
    download_id = uuid.uuid4().hex[:16]
    cancel_event = threading.Event()
    _set_dl(download_id, status='starting', downloaded=0, total=0, name=_safe_name(str(entry['song_info'].song_name)), cancel_event=cancel_event)
    threading.Thread(target=run_download, args=(download_id, token, cancel_event), daemon=True).start()
    return jsonify({'download_id': download_id})


@app.route('/api/download/<download_id>/progress')
def api_download_progress(download_id):
    # 只下发前端需要的字段（记录里还有 resp/event 等不可序列化对象）
    public_fields = ('status', 'downloaded', 'total', 'speed', 'name', 'subdir', 'message', 'updated')

    @stream_with_context
    def generate():
        yield 'retry: 10000\n\n'
        while True:
            rec = _get_dl(download_id)
            if not rec:
                yield 'event: error\ndata: {"message":"unknown download"}\n\n'
                return
            data = {k: rec.get(k) for k in public_fields if k in rec}
            yield f'event: progress\ndata: {json.dumps(data, ensure_ascii=False)}\n\n'
            if rec.get('status') in ('done', 'error', 'cancelled'):
                return
            time.sleep(0.3)

    return Response(generate(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.route('/api/download/<download_id>/cancel', methods=['POST'])
def api_download_cancel(download_id):
    '''终止未完成的下载: 置位取消事件并关闭上游连接，清理临时文件。'''
    rec = _get_dl(download_id)
    if not rec:
        return jsonify({'error': 'unknown download'}), 404
    status = rec.get('status')
    if status in ('done', 'error', 'cancelled'):
        return jsonify({'status': status})
    (rec.get('cancel_event') or threading.Event()).set()
    resp = rec.get('resp')
    if resp is not None:
        with suppress(Exception):
            resp.close()
    with DL_LOCK:
        cur = DOWNLOADS.get(download_id)
        if cur and cur.get('status') in ('starting', 'downloading'):
            cur['status'] = 'cancelled'
            cur['speed'] = 0
            cur['message'] = '已取消'
            cur['updated'] = time.time()
    return jsonify({'status': 'cancelled'})


@app.route('/api/download/<download_id>/delete', methods=['POST'])
def api_download_delete(download_id):
    '''删除已完成下载的文件并移除该条记录。路径经白名单 + realpath 校验。'''
    rec = _get_dl(download_id)
    if not rec:
        return jsonify({'error': 'unknown download'}), 404
    if rec.get('status') != 'done':
        return jsonify({'error': '仅已完成的下载可删除文件'}), 400
    safe_path = _validated_download_file(rec)
    if not safe_path:
        return jsonify({'error': '非法的文件路径'}), 403
    with suppress(OSError):
        os.remove(safe_path)
    with DL_LOCK:
        DOWNLOADS.pop(download_id, None)
    return jsonify({'ok': True})


@app.route('/api/download/<download_id>/reveal', methods=['POST'])
def api_download_reveal(download_id):
    '''在系统文件管理器中打开下载文件所在目录（Windows 下选中该文件）。'''
    rec = _get_dl(download_id)
    if not rec:
        return jsonify({'error': 'unknown download'}), 404
    safe_path = _validated_download_file(rec)
    if not safe_path:
        return jsonify({'error': '文件不存在'}), 404
    try:
        if sys.platform == 'win32':
            subprocess.Popen(['explorer', f'/select,{os.path.normpath(safe_path)}'])
        else:
            subprocess.Popen(['xdg-open', os.path.dirname(safe_path)])
    except Exception:
        return jsonify({'error': '无法打开文件管理器'}), 500
    return jsonify({'ok': True})


@app.route('/api/file/<download_id>')
def api_file(download_id):
    '''下发已完成的下载文件: 子目录限定在音源白名单，文件名净化并拒绝路径成分，
    再以 realpath 校验锁定在 downloads 目录内后分块下发。'''
    rec = _get_dl(download_id)
    if not rec or rec.get('status') != 'done' or not rec.get('name'):
        return Response('not ready', status=404)
    subdir = rec.get('subdir') or ''
    fname = _safe_name(str(rec.get('name') or ''))
    if (not fname) or fname in {'.', '..'} or ('/' in fname) or ('\\' in fname) or ('..' in fname) or subdir not in SOURCE_SHORT_WHITELIST:
        return Response('invalid file', status=403)
    safe_path = _resolve_inside(os.path.join(DOWNLOAD_DIR, subdir, fname), DOWNLOAD_DIR)
    if not safe_path:
        return Response('not found', status=404)
    return _serve_static(os.path.dirname(safe_path), os.path.basename(safe_path), as_attachment=True)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    url = f'http://127.0.0.1:{port}'
    print(f'\n  🎵  声轨 Soundtrack 音乐播放器已启动  →  {url}')
    print('      关闭本窗口即退出播放器\n')
    # 启动后自动打开浏览器（设 NO_BROWSER=1 可禁用）
    if os.environ.get('NO_BROWSER', '') != '1':
        import webbrowser
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    app.run(host='127.0.0.1', port=port, threaded=True, debug=False)
