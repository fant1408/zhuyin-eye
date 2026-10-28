#!/usr/bin/env python3
"""Build zhuyin-dict.js (Zhuyin syllable -> characters, plus next-character
association) from the libchewing data files.

Source : https://github.com/chewing/libchewing-data  (the repo that libchewing
         mounts as its `data/` submodule), files dict/chewing/tsi.csv and
         dict/chewing/word.csv, pinned to the commit libchewing master uses.
Usage  : python3 -I build_dict.py [--work DIR] [--out FILE]
         Downloads the two CSV files into DIR (default ./_work) if missing.
Output : window.ZHUYIN_DICT={v:1,chars:{...},next:{...},word:{...}};   (one line, UTF-8)
"""
import argparse
import json
import os
import re
import ssl
import sys
import urllib.request
from collections import defaultdict

DATA_REPO = "chewing/libchewing-data"
# Commit of the `data` submodule at libchewing master 3c4a93aa03d5 (2026-03-28).
DATA_COMMIT = "ea74f76dd2548b1d65d0ff70c3ae66057a6ad97d"
FILES = ("tsi.csv", "word.csv")
URL = "https://raw.githubusercontent.com/%s/%s/dict/chewing/%s"

MAX_CHARS_PER_SYLLABLE = 12   # characters kept per syllable (ranked by `score`, see build)
MAX_NEXT_PER_CHAR = 8         # followers kept per first character
MAX_NEXT_KEYS = 4000          # first characters kept in `next`

LIGHT = "˙"  # ˙
# syllable = [initial][medial][final][tone]; light tone may lead in some sources
SYL_RE = re.compile(
    "^(%s)?([ㄅ-ㄙ])?([ㄧ-ㄩ])?([ㄚ-ㄦ])?([ˊˇˋ%s])?$"
    % (LIGHT, LIGHT)
)


def is_cjk(ch):
    return len(ch) == 1 and 0x4E00 <= ord(ch) <= 0x9FFF


def normalize_syllable(s):
    """Return the canonical syllable (light tone mark moved to the end) or None."""
    m = SYL_RE.match(s)
    if not m:
        return None
    lead, ini, med, fin, tone = m.groups()
    if not (ini or med or fin):
        return None
    if lead and tone:
        return None  # two tone marks: malformed
    if lead:
        tone = LIGHT
    return (ini or "") + (med or "") + (fin or "") + (tone or "")


def fetch(work):
    os.makedirs(work, exist_ok=True)
    for name in FILES:
        path = os.path.join(work, name)
        if os.path.exists(path) and os.path.getsize(path) > 0:
            continue
        url = URL % (DATA_REPO, DATA_COMMIT, name)
        print("downloading", url, file=sys.stderr)
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(url, context=ctx, timeout=120) as r:
            data = r.read()
        with open(path, "wb") as f:
            f.write(data)


def read_csv(path):
    """Yield (word, freq, zhuyin) rows; skips '#' comment/header lines."""
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            parts = line.split(",")
            if len(parts) != 3:
                continue
            try:
                freq = int(parts[1])
            except ValueError:
                continue
            yield parts[0], freq, parts[2]


def build(work):
    tsi_path = os.path.join(work, "tsi.csv")
    word_path = os.path.join(work, "word.csv")

    # ---- chars: (syllable) -> {char: freq} --------------------------------
    # word.csv order is used only as a tie-breaker (it lists the usual
    # character first within a reading); word.csv-only readings get freq 0.
    word_rank = {}
    for i, (w, _f, z) in enumerate(read_csv(word_path)):
        syl = normalize_syllable(z)
        if is_cjk(w) and syl and (w, syl) not in word_rank:
            word_rank[(w, syl)] = i

    freq = {}      # (char, syllable) -> frequency
    for w, f, z in read_csv(tsi_path):
        if not is_cjk(w):
            continue
        syl = normalize_syllable(z)
        if syl is None:
            continue
        key = (w, syl)
        if key not in freq or f > freq[key]:
            freq[key] = f
    for key in word_rank:
        freq.setdefault(key, 0)

    # phrase_count[(char, syllable)]: summed frequency of multi-character tsi
    # phrases in which the char is read with that syllable.
    phrase_count = defaultdict(int)
    for w, f, z in read_csv(tsi_path):
        syls = z.split(" ")
        if len(w) < 2 or len(syls) != len(w):
            continue
        for ch, s in zip(w, syls):
            sy = normalize_syllable(s)
            if sy and is_cjk(ch):
                phrase_count[(ch, sy)] += f

    # Polyphonic chars: damp a reading by how rarely the char is actually read
    # that way inside phrases.
    #   score = freq(c,r) * (pc(c,r)+1) / (sum_r pc(c,r) + n_readings(c))
    readings = defaultdict(set)
    for ch, sy in list(freq) + list(phrase_count):
        readings[ch].add(sy)
    pc_total = defaultdict(int)
    for (ch, sy), n in phrase_count.items():
        pc_total[ch] += n

    def score(ch, sy):
        return (freq[(ch, sy)] * (phrase_count.get((ch, sy), 0) + 1)
                / (pc_total[ch] + len(readings[ch])))

    by_syl = defaultdict(list)
    for (ch, syl) in freq:
        by_syl[syl].append((-score(ch, syl), word_rank.get((ch, syl), 10**9), ord(ch), ch))
    chars = {}
    for syl in sorted(by_syl):
        items = sorted(by_syl[syl])[:MAX_CHARS_PER_SYLLABLE]
        chars[syl] = "".join(t[3] for t in items)

    # ---- next: first char -> followers by 2-char phrase frequency ----------
    # A phrase listed under several readings carries the same frequency on each
    # row, so count each distinct phrase once (max over its rows).
    phrase = {}
    for w, f, _z in read_csv(tsi_path):
        if len(w) == 2 and is_cjk(w[0]) and is_cjk(w[1]):
            if w not in phrase or f > phrase[w]:
                phrase[w] = f
    in_table = set("".join(chars.values()))
    follow = defaultdict(lambda: defaultdict(int))
    total = defaultdict(int)
    for w, f in phrase.items():
        if w[0] in in_table:
            follow[w[0]][w[1]] += f
            total[w[0]] += f
    firsts = sorted(total, key=lambda c: (-total[c], c))[:MAX_NEXT_KEYS]
    nxt = {}
    for c in firsts:
        ranked = sorted(follow[c].items(), key=lambda kv: (-kv[1], kv[0]))
        nxt[c] = "".join(k for k, _v in ranked[:MAX_NEXT_PER_CHAR])

    # ---- word: char -> most frequent 2-char phrase containing it ------------
    best = {}   # char -> (-freq, phrase); smallest tuple wins (ties: codepoint)
    for w, f in phrase.items():
        for c in set(w):
            if c in in_table and (c not in best or (-f, w) < best[c]):
                best[c] = (-f, w)
    word = {c: best[c][1] for c in sorted(best)}
    return big5_filter(chars, nxt, word)


def big5_ok(text):
    try:
        text.encode("cp950")
        return True
    except UnicodeEncodeError:
        return False


def big5_filter(chars, nxt, word):
    """Keep only characters encodable in cp950 (Big5): drops simplified forms
    and other chars Taiwan systems do not use. Empty entries are removed; a
    `word` phrase is dropped if either of its chars is not encodable."""
    def keep(text):
        return "".join(c for c in text if big5_ok(c))

    chars = {k: v for k, v in ((k, keep(v)) for k, v in chars.items()) if v}
    nxt = {k: v for k, v in ((k, keep(v)) for k, v in nxt.items() if big5_ok(k)) if v}
    word = {k: v for k, v in word.items() if big5_ok(k) and big5_ok(v)}
    return chars, nxt, word


# 兒童日常用字優先：詞頻排序和孩子實際常用的字不一樣時，手動把字移到最前面
PRIORITY = {"ㄏㄜ": "喝", "ㄉㄜˊ": "得"}


def apply_priority(chars):
    for key, front in PRIORITY.items():
        if key in chars:
            rest = "".join(c for c in chars[key] if c not in front)
            chars[key] = "".join(c for c in front if c in chars[key]) + rest
    return chars


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default=os.path.join(here, "_work", "src"))
    ap.add_argument("--out", default=os.path.join(here, "zhuyin-dict.js"))
    args = ap.parse_args()

    fetch(args.work)
    chars, nxt, word = build(args.work)
    chars = apply_priority(chars)
    js = "window.ZHUYIN_DICT={v:1,chars:%s,next:%s,word:%s};\n" % (
        dumps(chars), dumps(nxt), dumps(word))
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(js)
    print("wrote %s: %d bytes, %d syllables, %d next keys, %d word keys"
          % (args.out, len(js.encode("utf-8")), len(chars), len(nxt), len(word)))


if __name__ == "__main__":
    main()
