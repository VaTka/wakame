
# serial-react-demo v5 (final-fix)

Fixes:
- Front switching for granularity (raw/1min/5min/default) is reliable
- PDF export: JP font fallback, `lang=en|ja`, raw table, params (`windowMin/stepMin`)
- CSV export: UTF-8 BOM + `windowMin`
- SVG export: robust endpoint `/api/export/svg` (works like v3)

## Run
### Server
```
cd server
cp .env.example .env
# Put JP font at server/fonts/NotoSansJP-Regular.ttf or set PDF_FONT in .env
npm install
npm start
# (optional) start simulator
npm run dev:simulate
```

### Client
```
cd ../client
npm install
npm run dev
```

## Exports
- PDF (ja):
  `http://localhost:3001/api/export/pdf?process=molding&windowMin=60&stepMin=1&includeRaw=1&rawLimit=300&lang=ja`
- SVG:
  `http://localhost:3001/api/export/svg?process=packaging&windowMin=20&stepMin=5&lang=ja`
- CSV:
  `http://localhost:3001/api/export/csv?process=molding&windowMin=60`
