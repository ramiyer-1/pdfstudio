# PDF Studio

A fast, private web tool for combining images, PDFs and documents into one PDF, editing the pages, and downloading the result.
Everything runs in the browser, so files never leave the user's device. The server only serves static files.

## What it does

### Combine
- **Add anything**: JPG, PNG, WEBP, GIF, BMP, SVG, AVIF, **HEIC** (iPhone photos), **PDF**, **DOCX**, HTML, TXT/MD/CSV/JSON and source code.
- **Ways to add files**: the file picker, dragging files onto the page, dropping a whole folder, pasting a screenshot (Ctrl+V), or the phone camera.
- **PDFs are split into pages**, so you can mix pages from different files in any order.

### Arrange
- **Drag pages** to reorder them. Selected pages move together.
- **Sort**: by name A→Z or Z→A, in the order added, reversed, or interleaved (1a, 1b, 2a, 2b…).
- **Page actions**: rotate, duplicate, delete and full-size preview (← → to move between pages).
- **Bulk actions**: click to select, Shift+click to select a range, Ctrl+A to select everything. Then rotate, duplicate, delete, or move the selection to the start or end.
- **Undo and redo** for every change.

### Edit pages (✎ on any page, or **Edit** in the preview)
| Tool | What it does |
| --- | --- |
| **Text** | Type anywhere on the page. You can choose the font (Helvetica, Times, Courier), size, bold, italic, colour and opacity. Click existing text to change it. |
| **Draw** | Freehand pen (mouse, stylus or finger). |
| **Highlight** | A see-through marker over text. |
| **Box / Circle / Line / Arrow** | Shapes with your choice of colour, line width and fill. Hold Shift for squares and circles, or to snap lines to 45°. |
| **Whiteout** | Covers part of the page with white. Put new text on top to "replace" text. |
| **Image** | Insert a logo, stamp or photo. |
| **Sign** | Draw a signature and place it on the page. |

- Click an item to select it. Drag to move it, use the corner handle to resize, and press Del to delete. The arrow keys nudge it.
- The editor has its own undo and redo. **Done** saves your changes, and ‹ › save and move to the previous or next page.
- Pages with edits show ✎ in the grid, and their thumbnails include the edits.
- Edits follow the page when you rotate or reorder it.

### Export
- **Page size**: fit to content, A4, Letter, Legal, A3 or A5.
- **Layout**: orientation, margins, and image fit (fit, fill or stretch).
- **Image quality**: Original, High, Balanced or Small (compression).
- **Optional**: black & white images, and resizing PDF pages to the chosen size.
- **Extras**: page numbers, a diagonal watermark, and title/author metadata.
- **Partial export**: create the PDF from only the selected pages.

### How the output is built
- PDF pages are copied as vectors, so their text stays sharp and selectable.
- Text you add in the editor is written as **real PDF text**, so it can be selected, searched and copied.
  Shapes, lines and drawings are vector graphics.
- If added text uses characters the standard PDF fonts don't include (for example Hindi or emoji), it is embedded as a high-resolution image so it still displays correctly.
- JPEGs are embedded without re-compression where possible, and phone photos are rotated correctly using their EXIF orientation.
- Password-protected PDFs ask for the password. Their pages are rasterized in the output.

## Run it locally

Open `index.html` in a browser (double-clicking works), or serve the folder:

```bash
python3 -m http.server 8080      # then open http://localhost:8080
```

There's no build step and nothing to install. All libraries are in `vendor/`, so it also works offline.

## Deploy to a VPS

### Option A: nginx (recommended)

```bash
# on the VPS, from the unzipped pdf-studio folder
sudo apt install -y nginx
sudo mkdir -p /var/www/pdf-studio
sudo cp -r index.html styles.css app.js editor.js vendor /var/www/pdf-studio/
sudo cp deploy/nginx.conf /etc/nginx/sites-available/pdf-studio
sudo nano /etc/nginx/sites-available/pdf-studio        # set server_name to your domain or IP
sudo ln -s /etc/nginx/sites-available/pdf-studio /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default             # only if nothing else uses the default site
sudo nginx -t && sudo systemctl reload nginx

# HTTPS (strongly recommended)
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d pdf.example.com
```

To update later, copy the new `index.html`, `styles.css`, `app.js`, `editor.js` and `vendor/` over the old ones.
There's no need to restart anything.

### Option B: Docker

```bash
docker compose up -d --build          # serves on http://<vps-ip>:8080
# or
docker build -t pdf-studio . && docker run -d --name pdf-studio -p 8080:80 --restart unless-stopped pdf-studio
```

Put it behind your existing reverse proxy or HTTPS setup, or change the port mapping in `docker-compose.yml`.

## Files

```
index.html          page layout and markup
styles.css          styling (light and dark themes, mobile layout)
app.js              file import, page grid, reordering, settings and PDF generation
editor.js           page editor: text, shapes, drawing, highlight, whiteout, images, signatures
vendor/             pdf-lib, PDF.js (+ worker), SortableJS, mammoth (DOCX), heic2any (HEIC)
deploy/nginx.conf   nginx site config for a VPS
Dockerfile, docker-compose.yml, deploy/nginx-docker.conf   Docker deployment
```

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Ctrl+O | Add files |
| Ctrl+S | Create and download the PDF (in the editor: save the page) |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Ctrl+A | Select all pages |
| Delete | Delete selected pages or editor item |
| R / Shift+R | Rotate selected pages right / left |
| Editor: V T P H R O L A W | Select, Text, Draw, Highlight, Box, Circle, Line, Arrow, Whiteout |
| Esc | Clear selection / close preview or editor |

## Limits

- **Existing text** in a PDF can't be retyped in place. Use **Whiteout** over it and add new text on top.
  Whiteout only *covers* content visually: the original text is still inside the file.
  Don't rely on it to redact confidential information.
- Legacy `.doc`, PowerPoint and Excel files can't be converted in the browser. Export them to PDF first.
- DOCX and text files are laid out as page images. They keep headings, lists, tables and images, but the text isn't selectable.

## Libraries

[pdf-lib](https://github.com/Hopding/pdf-lib) (MIT), [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0), [SortableJS](https://github.com/SortableJS/Sortable) (MIT),
[mammoth](https://github.com/mwilliamson/mammoth.js) (BSD-2) and [heic2any](https://github.com/alexcorvi/heic2any) (MIT).
