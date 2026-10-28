# zhuyin-dict.js
Zhuyin (Bopomofo) to character dictionary for the web app: `window.ZHUYIN_DICT = {v:1, chars, next, word}`.
- `chars`: syllable (initial+medial+final+tone; 1st tone unmarked, light tone `˙` last) to up to 12 chars, most frequent first.
- `next`: first char to up to 8 likely second chars (4000 most frequent first chars, from 2-char phrases). `word`: char to its most frequent 2-char phrase.
- Load with `<script charset="utf-8" src="zhuyin-dict.js">`; the file is raw UTF-8, one line.

**Source:** libchewing data, https://github.com/chewing/libchewing-data (the `data/` submodule of https://github.com/chewing/libchewing).
Pinned to commit `ea74f76dd2548b1d65d0ff70c3ae66057a6ad97d`, the one libchewing master (`3c4a93aa03d5`, 2026-03-28) points at.
Files used: `dict/chewing/tsi.csv` (phrases, `word,freq,zhuyin`) and `dict/chewing/word.csv` (character readings).

**License:** the data files are marked `Copyright (c) 2025 libchewing Core Team`, `LGPL-2.1-or-later` (same as the libchewing code). This repo has no separate data license file. The generated dictionary is derived from that data, so keep this attribution with it.

**Rebuild:** `python3 -I build_dict.py` downloads the two CSVs into `_work/src/` and rewrites `zhuyin-dict.js`.
Rules: only U+4E00-9FFF chars; multi-reading chars are listed under each reading, ranked by freq x (phrase count of that reading + 1) / (phrase counts of all readings + number of readings), so a char's secondary reading ranks low (word.csv-only readings count as freq 0); 2-char phrases are counted once even if listed under several readings; `next` and `word` only cover chars present in `chars`.

後處理：產生後再用 cp950（Big5）編碼過濾，去掉台灣不用的簡體字形（如 个、头），見專案說明。
