#!/usr/bin/env python3
"""Bounded validate-and-extract helper for release preflight.

Usage: release-preflight-archive.py --name N --sha256 H [--dest DIR --require-index] < archive-bytes

Reads a .tar.gz from stdin, verifies its SHA-256, validates every member without
writing, and (with --dest) extracts regular files and directories only.
Exit 0 on success; on rejection prints "<name>: <reason>" to stderr and exits 1.
"""

import argparse
import gzip
import hashlib
import io
import os
import stat
import sys
import tarfile
import zlib

MIB = 1024 * 1024
MAX_COMPRESSED = 64 * MIB
MAX_TOTAL = 128 * MIB
MAX_TAR_OVERHEAD = 8 * MIB
MAX_FILE = 16 * MIB
MAX_MEMBERS = 2000
MAX_PATH_BYTES = 240
MAX_SEGMENTS = 16
CHUNK = 1024 * 1024
MIN_END_BLOCKS = 1024

FILESYSTEM_METADATA_NAMES = frozenset({
    ".ds_store",
    "__macosx",
    "thumbs.db",
    "desktop.ini",
})


def is_filesystem_metadata_segment(segment):
    return segment.casefold() in FILESYSTEM_METADATA_NAMES or segment.startswith("._")

TYPE_NAMES = {
    tarfile.REGTYPE: "regular file",
    tarfile.AREGTYPE: "regular file",
    tarfile.DIRTYPE: "directory",
    tarfile.SYMTYPE: "symbolic link",
    tarfile.LNKTYPE: "hard link",
    tarfile.CHRTYPE: "character device",
    tarfile.BLKTYPE: "block device",
    tarfile.FIFOTYPE: "FIFO",
    tarfile.CONTTYPE: "contiguous file",
    tarfile.GNUTYPE_SPARSE: "sparse file",
}


class Reject(Exception):
    pass


def describe_type(ti):
    label = TYPE_NAMES.get(ti.type)
    code = ti.type.decode("latin-1") if isinstance(ti.type, bytes) else str(ti.type)
    if label is None:
        label = "unsupported type"
    return "%s, typeflag %s" % (label, ascii(code))


def entry_label(ti):
    return "entry %s (%s)" % (ascii(ti.name), describe_type(ti))


def read_input():
    data = sys.stdin.buffer.read(MAX_COMPRESSED + 1)
    if len(data) > MAX_COMPRESSED:
        raise Reject("compressed input exceeds %d MiB" % (MAX_COMPRESSED // MIB))
    return data


def decompress(data):
    limit = MAX_TOTAL + MAX_TAR_OVERHEAD
    out = bytearray()
    with gzip.GzipFile(fileobj=io.BytesIO(data), mode="rb") as gz:
        while True:
            chunk = gz.read(CHUNK)
            if not chunk:
                break
            out += chunk
            if len(out) > limit:
                raise Reject("uncompressed data exceeds %d MiB plus tar overhead" % (MAX_TOTAL // MIB))
    return bytes(out)


def normalise(ti):
    """Return the list of path segments for a member, or raise Reject."""
    raw = ti.name
    if "\x00" in raw:
        raise Reject("%s: NUL byte in path" % entry_label(ti))
    if "\\" in raw:
        raise Reject("%s: backslash in path" % entry_label(ti))
    if raw.startswith("/"):
        raise Reject("%s: absolute path" % entry_label(ti))
    if len(raw.encode("utf-8", "surrogateescape")) > MAX_PATH_BYTES:
        raise Reject("%s: path longer than %d bytes" % (entry_label(ti), MAX_PATH_BYTES))
    parts = raw.split("/")
    if ".." in parts:
        raise Reject("%s: '..' path segment" % entry_label(ti))
    segments = [p for p in parts if p not in ("", ".")]
    if len(segments) > MAX_SEGMENTS:
        raise Reject("%s: path deeper than %d levels" % (entry_label(ti), MAX_SEGMENTS))
    return segments


def validate(tf, stream_len, reject_top_level=()):
    """Pass 1: validate every member without writing. Returns [(TarInfo, segments)]."""
    plan = []
    files = {}  # casefolded path -> original path
    dirs = {}
    total = 0
    count = 0
    for ti in tf:
        count += 1
        if count > MAX_MEMBERS:
            raise Reject("more than %d members" % MAX_MEMBERS)
        if ti.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE) or getattr(ti, "sparse", None) is not None:
            raise Reject("%s: not a regular file or directory" % entry_label(ti))
        segments = normalise(ti)
        for seg in segments:
            if is_filesystem_metadata_segment(seg):
                raise Reject("%s: unintended filesystem metadata artifact" % entry_label(ti))
        is_dir = ti.type == tarfile.DIRTYPE
        if segments and segments[0].casefold() in reject_top_level:
            raise Reject("%s: top-level %s collides with a reserved directory" % (entry_label(ti), ascii(segments[0])))
        if not segments:
            if not is_dir:
                raise Reject("%s: file with empty path" % entry_label(ti))
            plan.append((ti, segments))
            continue
        key = "/".join(segments).casefold()
        shown = "/".join(segments)
        if key in files or (key in dirs and dirs[key][1]):
            raise Reject("%s: duplicate path (case-insensitive)" % entry_label(ti))
        if is_dir:
            if key in files:
                raise Reject("%s: file and directory conflict" % entry_label(ti))
        else:
            if key in dirs:
                raise Reject("%s: file and directory conflict" % entry_label(ti))
            if ti.size > MAX_FILE:
                raise Reject("%s: file larger than %d MiB" % (entry_label(ti), MAX_FILE // MIB))
            total += ti.size
            if total > MAX_TOTAL:
                raise Reject("%s: total content exceeds %d MiB" % (entry_label(ti), MAX_TOTAL // MIB))
            if ti.offset_data + ti.size > stream_len:
                raise Reject("%s: declared size exceeds data supplied" % entry_label(ti))
        # parents are implicit directories
        for i in range(1, len(segments)):
            pkey = "/".join(segments[:i]).casefold()
            if pkey in files:
                raise Reject("%s: file and directory conflict" % entry_label(ti))
            dirs.setdefault(pkey, ("/".join(segments[:i]), False))
        if is_dir:
            dirs[key] = (shown, True)
        else:
            files[key] = shown
        plan.append((ti, segments))
    return plan


def check_end_blocks(data, offset):
    rest = data[offset:]
    if len(rest) < MIN_END_BLOCKS:
        raise Reject("missing end-of-archive zero blocks")
    if rest != bytes(len(rest)):
        raise Reject("trailing bytes after end-of-archive blocks")


def make_dir(path):
    try:
        os.mkdir(path, 0o755)
    except FileExistsError:
        st = os.lstat(path)
        if not stat.S_ISDIR(st.st_mode):
            raise Reject("%s exists and is not a directory" % ascii(path))
    else:
        os.chmod(path, 0o755)


def extract(tf, plan, dest, dest_may_exist_empty=False):
    """Pass 2: write validated members under dest."""
    try:
        os.mkdir(dest, 0o755)
    except FileExistsError:
        st = os.lstat(dest)
        if not dest_may_exist_empty or not stat.S_ISDIR(st.st_mode) or os.listdir(dest):
            raise Reject("destination %s already exists" % ascii(dest))
    os.chmod(dest, 0o755)
    root = os.path.realpath(dest)
    for ti, segments in plan:
        if not segments:
            continue
        # Defensive containment check on the normalised path.
        target = os.path.join(root, *segments)
        if os.path.commonpath([root, os.path.normpath(target)]) != root or os.path.normpath(target) == root:
            raise Reject("entry %s escapes the destination" % ascii(ti.name))
        for i in range(1, len(segments)):
            make_dir(os.path.join(root, *segments[:i]))
        if ti.type == tarfile.DIRTYPE:
            make_dir(target)
            continue
        src = tf.extractfile(ti)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        fd = os.open(target, flags, 0o644)
        try:
            os.fchmod(fd, 0o644)
            remaining = ti.size
            while remaining > 0:
                chunk = src.read(min(CHUNK, remaining))
                if not chunk:
                    raise Reject("entry %s: data ended early" % ascii(ti.name))
                view = memoryview(chunk)
                while view:
                    written = os.write(fd, view)
                    view = view[written:]
                remaining -= len(chunk)
        finally:
            os.close(fd)


def require_index(dest):
    index = os.path.join(dest, "index.html")
    try:
        st = os.lstat(index)
    except FileNotFoundError:
        raise Reject("missing index.html at archive root")
    if not stat.S_ISREG(st.st_mode):
        raise Reject("index.html at archive root is not a regular file")


def run(args):
    data = read_input()
    digest = hashlib.sha256(data).hexdigest()
    if digest != args.sha256.lower():
        raise Reject("SHA-256 mismatch: expected %s, computed %s" % (args.sha256, digest))
    raw = decompress(data)
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as tf:
        reserved = tuple(name.casefold() for name in (args.reject_top_level or []))
        plan = validate(tf, len(raw), reserved)
        check_end_blocks(raw, tf.offset)
        if args.dest:
            if args.require_index and not any(
                s == ["index.html"] and t.type != tarfile.DIRTYPE for t, s in plan
            ):
                raise Reject("missing index.html at archive root")
            extract(tf, plan, args.dest, args.dest_may_exist_empty)
            if args.require_index:
                require_index(args.dest)
    if args.require_index and not args.dest:
        raise Reject("--require-index needs --dest")


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--name", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--dest")
    parser.add_argument("--require-index", action="store_true")
    # Reject any member whose first path segment matches NAME (case-insensitive). Repeatable.
    parser.add_argument("--reject-top-level", action="append", metavar="NAME")
    # Allow --dest to be an existing, empty, non-symlink directory (the staging root).
    parser.add_argument("--dest-may-exist-empty", action="store_true")
    try:
        args = parser.parse_args()
    except SystemExit:
        sys.stderr.write("release-preflight-archive.py: invalid arguments\n")
        return 2
    try:
        run(args)
    except Reject as err:
        sys.stderr.write("%s: %s\n" % (args.name, str(err).replace("\n", " ")))
        return 1
    except (EOFError, gzip.BadGzipFile, zlib.error, tarfile.TarError, OSError, UnicodeError) as err:
        sys.stderr.write(
            "%s: malformed or unreadable archive (%s: %s)\n"
            % (args.name, type(err).__name__, str(err).replace("\n", " "))
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
