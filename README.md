# Kookoo FTT Practice

Mobile-friendly Singapore Final Theory Test practice app.

## Features

- 10 full FTT practice sets with 50 questions each
- 50-minute timed exam mode
- One active attempt per test set
- Immediate local autosave for answers, flags, and resume state
- Optional question-order shuffle before starting a test
- Manual submit after all questions are answered
- Auto-submit when time runs out
- Result page with pass mark of 45/50
- Review mode with filters for all, incorrect, unanswered, and flagged questions
- Local-device attempt history
- Inline images for image-based questions with enlarge-on-tap support

## Tech Stack

- Vite
- React
- TypeScript
- Static JSON data served from `public/data`
- Local storage for attempts and history

## Local Development

```bash
npm install
npm run dev
```

The dev server runs on the Vite default unless you pass a specific host/port.

## Build

```bash
npm run build
```

The production output is generated in `dist/`.

## Vercel Deployment

Use these settings when importing the GitHub repo into Vercel:

- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`

No backend is required. The question bank and image crops are committed under `public/data`, so Vercel serves them as static assets.

## Data Notes

Raw OCR/extraction working files are intentionally ignored:

- `ftt/`
- `extracted/`
- `tools/`

The app only needs the processed static assets in `public/data`.
