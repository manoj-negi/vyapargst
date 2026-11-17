# Import purchase bill: free local reading (setup)

Bills are read **on this computer**, free, with no paid API. Documents never leave the Mac in local mode.

| Step | Tool | Licence | Needed for |
|---|---|---|---|
| Direct reading | built in (pdf.js, SheetJS, mammoth) | Apache-2.0 / MIT-style | Text PDFs, Excel/ODS/CSV/TSV, Word/ODT/RTF/TXT tables. Works with nothing else installed and with Ollama stopped. |
| OCR | Tesseract 5 (`brew install tesseract`) | Apache-2.0 | Photos and scanned PDFs |
| PDF pages → images | poppler `pdftoppm` (`brew install poppler`) | GPL (run as a separate program) | Scanned PDFs with more than one page (macOS `sips` handles page 1 without it) |
| Optional local AI | Ollama (`brew install ollama`) + model `granite3.3:2b` | Ollama MIT; Granite 3.3 Apache-2.0 | Only when the local parser cannot find the item table or the totals don't add up |

Anthropic Claude stays available but is **never used unless** you set both `AI_IMPORT_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`.

## Commands (macOS, Homebrew)

```sh
# OCR (required for photos/scans)
brew install tesseract poppler
tesseract --version            # check
# Hindi text on bills (optional): brew install tesseract-lang, then set OCR_LANGS=eng+hin

# Optional local AI
brew install ollama
brew services start ollama     # runs now and at every login (stop: brew services stop ollama)
ollama pull granite3.3:2b      # one-time download, about 1.5 GB
ollama list                    # check
```

The Import page shows the live status of each part (OCR, page rendering, local AI) and the exact command when something is missing.

## Size, memory, speed (measured on this Mac: M1 MacBook Air, 8 GB RAM)

| Path | Time per one-page bill | Memory |
|---|---|---|
| Text PDF / Excel / Word | 1–3 s | negligible |
| Scanned PDF or phone photo (Tesseract) | 2–7 s | ~200 MB while running |
| Local AI fallback (`granite3.3:2b`, 8k context) | ~2.5 min | ~2.0 GB while loaded (unloaded 5 min after use) |

Larger models (7–8B) do not fit comfortably beside the app and PostgreSQL in 8 GB. On a 16 GB+ Mac a larger Apache/MIT-licensed model can be set with `LOCAL_AI_MODEL`. Ollama **cloud** models (`…-cloud`) and non-local Ollama servers are refused.

**Honest note on the local AI:** on the real test bill it was slow and often put numbers in the wrong field (e.g. rate incl. tax, half the GST rate). Every value it returns is checked against the document text: numbers, GSTINs, HSN codes, invoice numbers and dates that are not printed are removed; lines whose qty × rate does not give their amount are flagged; invented lines are dropped. Treat its output as a rough start and check every line. The local parser + OCR is the main path.

## What must be running

- **Always:** the app server (and PostgreSQL).
- **For photos/scans:** nothing extra; Tesseract and pdftoppm are run per bill.
- **For the optional AI:** Ollama (`brew services start ollama`). If it is stopped, bills are still read directly or by OCR; the read report says "Local AI: not running" with the start command.

## Phones (Android/iOS app)

The phone only takes the photo and uploads it; reading happens on the **backend (this Mac)**. The phone must reach the server (same Wi-Fi with the server URL set in the app, or your hosted URL). If the Mac is off or unreachable, the app shows "Connection required".

## Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `AI_IMPORT_PROVIDER` | `local` | `local` = free local reading; `anthropic` = Claude (paid, needs `ANTHROPIC_API_KEY`) |
| `LOCAL_AI_MODEL` | `granite3.3:2b` | Ollama model used for the optional fallback |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Must be this computer; another host is refused unless `OLLAMA_ALLOW_REMOTE=1` |
| `LOCAL_AI_TIMEOUT_MS` | `240000` | Give up on the local model after this |
| `OCR_LANGS` | `eng` | e.g. `eng+hin` once the Hindi data is installed |
| `TESSERACT_PATH`, `PDFTOPPM_PATH` | found in Homebrew paths | Only if installed elsewhere |

## Limits (no perfect reading is promised)

- Handwritten bills, very blurred or dark photos, and unusual layouts may give few or no lines. The screen then says plainly what was and was not read, keeps everything found, and you add or fix the lines.
- OCR look-alike mistakes (O/0, I/1) in GSTINs are corrected only when the GSTIN check digit confirms it; otherwise the GSTIN is left empty for you.
- Totals are always recalculated by the app's GST engine and compared with the printed total; nothing is posted until you confirm.
