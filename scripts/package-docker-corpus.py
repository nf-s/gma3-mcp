#!/usr/bin/env python3
"""Prepare an atomic, local-only manual/release corpus build context."""
import argparse
import json
import re
import tempfile
from pathlib import Path

USER_PATH = re.compile(r"/(?:Users|home)/[^/\s\"'<>]+")
SENSITIVE = re.compile(rb"/Users/|/home/|BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}")
TEXT_SUFFIXES = {'.md', '.html', '.json', '.jsonl', '.txt', '.svg', '.css', '.js'}


def reject_symlinks(path, recursive=False):
    if any(parent.is_symlink() for parent in (path, *path.parents)):
        raise ValueError('Corpus paths must not contain symbolic links')
    if recursive and path.is_dir() and any(child.is_symlink() for child in path.rglob('*')):
        raise ValueError('Corpus inputs must not contain symbolic links')


def clean(value):
    if isinstance(value, dict):
        return {
            key: clean(item) for key, item in value.items()
            if key not in {'live_lua_signature', 'live_keyword_tokens', 'source_path'}
        }
    if isinstance(value, list):
        return [clean(item) for item in value]
    return value


def prepare(source_root, destination):
    source_root = source_root.absolute()
    destination = destination.absolute()
    reject_symlinks(source_root)
    reject_symlinks(destination)
    source_root = source_root.resolve()
    destination = destination.resolve()
    if destination.exists():
        raise ValueError('Destination must not exist')
    if destination.is_relative_to(source_root):
        raise ValueError('Destination must be outside the source directory')
    inputs = []
    documents = 0
    for kind in ('manual', 'releases'):
        for name in ('documents.jsonl', 'commands.jsonl', 'navigation.json', 'possible-revisions.jsonl'):
            source = source_root / 'data' / kind / name
            if source.is_file():
                reject_symlinks(source)
                inputs.append(source)
                if name == 'documents.jsonl':
                    documents += sum(1 for line in source.read_text().splitlines() if line.strip())
        for directory in ('content', 'assets'):
            source = source_root / directory / kind
            if source.exists():
                reject_symlinks(source, recursive=True)
                inputs.extend(path for path in source.rglob('*') if path.is_file())
    pdf_root = source_root / 'release-notes-pdf'
    if pdf_root.exists():
        reject_symlinks(pdf_root, recursive=True)
        inputs.extend(pdf_root.glob('*.pdf'))
    if not documents:
        raise ValueError('At least one real manual or release document is required')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.ma3-corpus-', dir=destination.parent) as temporary:
        staged = Path(temporary) / 'corpus'
        staged.mkdir()
        for source in inputs:
            reject_symlinks(source)
            relative = source.relative_to(source_root)
            if SENSITIVE.search(str(relative).encode()):
                raise ValueError('Sensitive pattern in corpus filename')
            raw = source.read_bytes()
            if source.suffix in TEXT_SUFFIXES:
                text = raw.decode('utf-8')
                if relative.parts[0] == 'data':
                    if source.suffix == '.jsonl':
                        records = [clean(json.loads(line)) for line in text.splitlines() if line.strip()]
                        text = ''.join(json.dumps(record, ensure_ascii=False) + '\n' for record in records)
                    else:
                        text = json.dumps(clean(json.loads(text)), ensure_ascii=False)
                raw = USER_PATH.sub('/source', text).encode('utf-8')
            if SENSITIVE.search(raw):
                raise ValueError('Sensitive path or common credential pattern remains')
            target = staged / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        staged.rename(destination)
    print(f'Prepared {documents} manual/release documents; excluded caches, guides and console captures.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    try:
        prepare(args.source, args.destination)
    except (ValueError, OSError) as error:
        parser.exit(1, f'{error}\n')
