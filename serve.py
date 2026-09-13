#!/usr/bin/env python3
"""Serve this static project page with HTTP byte-range support.

Python 3.10's ``python -m http.server`` ignores Range requests. Browsers need
those requests to seek to an unbuffered position in a long MP4, so this small
development server adds single-range responses without any third-party
dependencies.
"""

from __future__ import annotations

import argparse
import os
import re
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


RANGE_PATTERN = re.compile(r"bytes=(\d*)-(\d*)$")


class RangeRequestHandler(SimpleHTTPRequestHandler):
    """Static-file handler with the byte ranges used by HTML video players."""

    def end_headers(self) -> None:
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_head(self):
        self._requested_range: tuple[int, int] | None = None
        range_header = self.headers.get("Range")
        if not range_header:
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()

        try:
            source = open(path, "rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        stat = os.fstat(source.fileno())
        size = stat.st_size
        match = RANGE_PATTERN.fullmatch(range_header.strip())

        if not match or size == 0:
            return self._reject_range(source, size)

        first, last = match.groups()
        try:
            if not first:
                suffix_length = int(last or 0)
                if suffix_length <= 0:
                    return self._reject_range(source, size)
                start = max(size - suffix_length, 0)
                end = size - 1
            else:
                start = int(first)
                end = int(last) if last else size - 1
                end = min(end, size - 1)
        except ValueError:
            return self._reject_range(source, size)

        if start >= size or end < start:
            return self._reject_range(source, size)

        self._requested_range = (start, end)
        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
        self.end_headers()
        return source

    def _reject_range(self, source, size: int):
        source.close()
        self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
        self.send_header("Content-Range", f"bytes */{size}")
        self.send_header("Content-Length", "0")
        self.end_headers()
        return None

    def copyfile(self, source, outputfile) -> None:
        if self._requested_range is None:
            super().copyfile(source, outputfile)
            return

        start, end = self._requested_range
        source.seek(start)
        remaining = end - start + 1
        while remaining:
            chunk = source.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Preview the PASSAGE project page with seekable videos."
    )
    parser.add_argument("port", nargs="?", type=int, default=8000)
    parser.add_argument("--bind", default="127.0.0.1", metavar="ADDRESS")
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parent
    handler = partial(RangeRequestHandler, directory=str(project_root))
    server = ThreadingHTTPServer((args.bind, args.port), handler)

    display_host = "localhost" if args.bind in {"127.0.0.1", "localhost"} else args.bind
    print(f"Serving {project_root}")
    print(f"Open http://{display_host}:{args.port}/")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
