#!/usr/bin/env python3
"""Create or normalize release archives with case-insensitive metadata exclusion.

Usage:
  create-release-archive.py static --source DIR --output FILE
  create-release-archive.py clean-tgz --input FILE [--output FILE]

Reuses the single-source validation and metadata exclusion policy from
scripts/release-preflight-archive.py. Structural validation (member types,
paths, duplicates, conflicts, per-file/aggregate limits, and end-of-archive
blocks) runs before metadata exclusion, and emitted archives are validated
against the strict preflight contract before atomic publication.
"""

import sys

sys.dont_write_bytecode = True

import argparse
import gzip
import importlib.util
import io
import os
import stat
import tarfile
import tempfile


def load_preflight_module():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    preflight_path = os.path.join(script_dir, "release-preflight-archive.py")
    spec = importlib.util.spec_from_file_location("release_preflight_archive", preflight_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load release-preflight-archive.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


preflight = load_preflight_module()
Reject = preflight.Reject


def make_dir_tarinfo(name):
    ti = tarfile.TarInfo(name)
    ti.type = tarfile.DIRTYPE
    ti.mode = 0o755
    ti.mtime = 0
    ti.uid = 0
    ti.gid = 0
    ti.uname = ""
    ti.gname = ""
    return ti


def make_file_tarinfo(name, size):
    ti = tarfile.TarInfo(name)
    ti.type = tarfile.REGTYPE
    ti.mode = 0o644
    ti.size = size
    ti.mtime = 0
    ti.uid = 0
    ti.gid = 0
    ti.uname = ""
    ti.gname = ""
    return ti


def compress_and_verify_archive(tar_bytes):
    gz_buf = io.BytesIO()
    with gzip.GzipFile(fileobj=gz_buf, mode="wb", mtime=0) as gz_fh:
        gz_fh.write(tar_bytes)
    gz_bytes = gz_buf.getvalue()
    if len(gz_bytes) > preflight.MAX_COMPRESSED:
        raise Reject("compressed output exceeds %d MiB" % (preflight.MAX_COMPRESSED // preflight.MIB))

    verified_raw = preflight.decompress(gz_bytes)
    with tarfile.open(fileobj=io.BytesIO(verified_raw), mode="r:") as verify_tf:
        preflight.validate(verify_tf, len(verified_raw), allow_filesystem_metadata=False)
        preflight.check_end_blocks(verified_raw, verify_tf.offset)
    return gz_bytes


def write_bytes_atomic(data, output_path):
    out_abs = os.path.abspath(output_path)
    out_dir = os.path.dirname(out_abs)
    try:
        dir_stat = os.lstat(out_dir)
    except FileNotFoundError:
        raise Reject("output directory %s does not exist" % ascii(out_dir))
    if not stat.S_ISDIR(dir_stat.st_mode):
        raise Reject("output parent %s is not a directory" % ascii(out_dir))

    fd, tmp_path = tempfile.mkstemp(prefix=".tmp-archive-", suffix=".tar.gz", dir=out_dir)
    try:
        with os.fdopen(fd, "wb") as raw_fh:
            raw_fh.write(data)
        os.chmod(tmp_path, 0o644)
        os.replace(tmp_path, out_abs)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def create_static_archive(source_dir, output_path):
    try:
        src_stat = os.lstat(source_dir)
    except FileNotFoundError:
        raise Reject("source directory %s does not exist" % ascii(source_dir))
    if not stat.S_ISDIR(src_stat.st_mode):
        raise Reject("source %s is not a directory" % ascii(source_dir))

    tar_buf = io.BytesIO()
    count = 1
    total_bytes = 0
    with tarfile.open(fileobj=tar_buf, mode="w", format=tarfile.PAX_FORMAT) as tf:
        tf.addfile(make_dir_tarinfo("."))
        for dirpath, dirs, files in os.walk(source_dir, topdown=True, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not preflight.is_filesystem_metadata_segment(d))
            clean_files = sorted(f for f in files if not preflight.is_filesystem_metadata_segment(f))
            rel_dir = os.path.relpath(dirpath, source_dir)
            rel_parts = [] if rel_dir == "." else rel_dir.split(os.sep)

            for d in dirs:
                full_dir = os.path.join(dirpath, d)
                st = os.lstat(full_dir)
                if not stat.S_ISDIR(st.st_mode):
                    raise Reject("entry %s: non-directory entry (symlink or special file) is not allowed" % ascii(full_dir))
                count += 1
                if count > preflight.MAX_MEMBERS:
                    raise Reject("more than %d members" % preflight.MAX_MEMBERS)
                member_name = "./" + "/".join(rel_parts + [d])
                ti = make_dir_tarinfo(member_name)
                preflight.normalise(ti)
                tf.addfile(ti)

            for f in clean_files:
                full_file = os.path.join(dirpath, f)
                st = os.lstat(full_file)
                if not stat.S_ISREG(st.st_mode):
                    raise Reject("entry %s: non-regular entry (symlink or special file) is not allowed" % ascii(full_file))
                count += 1
                if count > preflight.MAX_MEMBERS:
                    raise Reject("more than %d members" % preflight.MAX_MEMBERS)
                if st.st_size > preflight.MAX_FILE:
                    raise Reject("entry %s: file larger than %d MiB" % (ascii(full_file), preflight.MAX_FILE // preflight.MIB))
                total_bytes += st.st_size
                if total_bytes > preflight.MAX_TOTAL:
                    raise Reject("entry %s: total content exceeds %d MiB" % (ascii(full_file), preflight.MAX_TOTAL // preflight.MIB))
                with open(full_file, "rb") as fh:
                    data = fh.read()
                member_name = "./" + "/".join(rel_parts + [f])
                ti = make_file_tarinfo(member_name, len(data))
                preflight.normalise(ti)
                tf.addfile(ti, io.BytesIO(data))

    gz_bytes = compress_and_verify_archive(tar_buf.getvalue())
    write_bytes_atomic(gz_bytes, output_path)


def clean_tgz_archive(input_path, output_path):
    try:
        in_stat = os.lstat(input_path)
    except FileNotFoundError:
        raise Reject("input archive %s does not exist" % ascii(input_path))
    if not stat.S_ISREG(in_stat.st_mode):
        raise Reject("input archive %s is not a regular file" % ascii(input_path))

    with open(input_path, "rb") as fh:
        compressed = fh.read(preflight.MAX_COMPRESSED + 1)
    if len(compressed) > preflight.MAX_COMPRESSED:
        raise Reject("compressed input exceeds %d MiB" % (preflight.MAX_COMPRESSED // preflight.MIB))

    raw = preflight.decompress(compressed)
    out_buf = io.BytesIO()

    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as src_tf:
        # Pass 1: validate full input archive structural integrity, uniqueness,
        # and resource limits BEFORE excluding any filesystem metadata members.
        plan = preflight.validate(src_tf, len(raw), allow_filesystem_metadata=True)
        preflight.check_end_blocks(raw, src_tf.offset)

        # Pass 2: emit clean archive omitting only validated filesystem metadata.
        with tarfile.open(fileobj=out_buf, mode="w", format=tarfile.PAX_FORMAT) as dst_tf:
            for ti, segments in plan:
                if any(preflight.is_filesystem_metadata_segment(seg) for seg in segments):
                    continue
                if ti.type == tarfile.DIRTYPE:
                    dst_tf.addfile(make_dir_tarinfo(ti.name))
                else:
                    src_fh = src_tf.extractfile(ti)
                    payload = src_fh.read() if src_fh is not None else b""
                    if len(payload) != ti.size:
                        raise Reject("%s: data ended early" % preflight.entry_label(ti))
                    dst_tf.addfile(make_file_tarinfo(ti.name, len(payload)), io.BytesIO(payload))

    # Pass 3: verify the emitted bytes against strict preflight before publication.
    gz_bytes = compress_and_verify_archive(out_buf.getvalue())
    write_bytes_atomic(gz_bytes, output_path)


def main():
    parser = argparse.ArgumentParser(add_help=False)
    sub = parser.add_subparsers(dest="command", required=True)

    static_parser = sub.add_parser("static", add_help=False)
    static_parser.add_argument("--source", required=True)
    static_parser.add_argument("--output", required=True)

    clean_parser = sub.add_parser("clean-tgz", add_help=False)
    clean_parser.add_argument("--input", required=True)
    clean_parser.add_argument("--output")

    try:
        args = parser.parse_args()
    except SystemExit:
        sys.stderr.write("create-release-archive.py: invalid arguments\n")
        return 2

    try:
        if args.command == "static":
            create_static_archive(args.source, args.output)
        elif args.command == "clean-tgz":
            clean_tgz_archive(args.input, args.output or args.input)
        else:
            sys.stderr.write("create-release-archive.py: unknown command\n")
            return 2
    except Reject as err:
        sys.stderr.write("create-release-archive.py: %s\n" % str(err).replace("\n", " "))
        return 1
    except (EOFError, gzip.BadGzipFile, tarfile.TarError, OSError, UnicodeError) as err:
        sys.stderr.write(
            "create-release-archive.py: archive error (%s: %s)\n"
            % (type(err).__name__, str(err).replace("\n", " "))
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
