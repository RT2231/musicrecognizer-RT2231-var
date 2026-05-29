/**
 * Vercel Edge Middleware — Markdown for Agents
 *
 * Accept: text/markdown を含むリクエストに対して
 * アプリの Markdown 概要を返す。ブラウザは通常の HTML を受け取る。
 *
 * https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/
 */

export const config = {
  matcher: ['/', '/index.html'],
}

const MARKDOWN = `# Trackora — Music Recognition Tool

> Identify any song instantly from an audio file or microphone recording.

## Overview

Trackora is a browser-based music recognition web app that runs entirely on
Cloudflare Pages (frontend) + Cloudflare Workers (API proxy) + Cloudflare D1
(SQLite, cloud sync). No paid plans required.

## How It Works

1. Drop an audio/video file or record with your microphone
2. The audio is preprocessed in-browser (trim → mono → 16 kHz → WAV)
3. ACRCloud fingerprints the audio and returns up to 5 ranked candidates
4. MusicBrainz, iTunes, Wikipedia, Spotify and YouTube are queried in parallel
5. Results are displayed with album art, confidence scores, streaming links and
   an embedded YouTube player

## Key Features

- **Music recognition** via ACRCloud with confidence scores and multiple candidates
- **Rich metadata** from MusicBrainz (ISRC, genres, works, composers, ratings)
- **YouTube MV** embedded (auto-skips embed-blocked videos)
- **Spotify embed** player + playlist add (OAuth)
- **iTunes 30-second preview** + Apple Music direct link
- **Wikipedia** artist summary (Japanese preferred, English fallback)
- **Recognition history** stored in IndexedDB + Cloudflare D1 cloud sync
- **Global ranking** (all-time / monthly) across all anonymous users
- **Offline support** via Service Worker (Cache First strategy)
- **Comparison table** for up to 5 tracks side-by-side
- **Share card** image generation (Canvas, no external libraries)
- **Dark mode**, keyboard shortcuts, stats dashboard

## API Endpoints (Cloudflare Worker)

| Method | Path | Description |
|--------|------|-------------|
| POST | \`/\` | Music recognition (ACRCloud) |
| POST | \`/musicbrainz\` | Recording metadata |
| POST | \`/itunes\` | Artwork + preview URL |
| POST | \`/youtube\` | MV search (top 3) |
| POST | \`/wikipedia\` | Artist summary |
| POST | \`/spotify\` | Track details |
| POST | \`/spotify/auth\` | OAuth authorization URL |
| POST | \`/spotify/callback\` | Token exchange |
| POST | \`/spotify/playlist/add\` | Add to playlist |
| POST | \`/cloud/sync\` | Save recognition to D1 |
| POST | \`/cloud/history\` | Fetch user history |
| GET  | \`/cloud/ranking\` | Global ranking |
| POST | \`/cloud/ranking/user\` | User TOP 10 |

## Tech Stack

- **Frontend**: Vanilla JS + CSS (no UI frameworks), Canvas for charts/visualizer/share card
- **Backend**: Cloudflare Workers (ES modules)
- **Database**: Cloudflare D1 (SQLite) for cloud sync
- **Local storage**: IndexedDB
- **Hosting**: Vercel (static) + Cloudflare Workers (API)

## Links

- **App**: https://musicrecognizer-rt2231-var.vercel.app/
- **Source**: https://github.com/RT2231/musicrecognizer-RT2231-var
- **API**: https://acrcloud.shirokuma0822.workers.dev/
- **MCP Server Card**: https://musicrecognizer-rt2231-var.vercel.app/.well-known/mcp/server-card.json
- **API Catalog**: https://musicrecognizer-rt2231-var.vercel.app/.well-known/api-catalog
`;

export default function middleware(request) {
  const accept = request.headers.get('accept') || '';
  if (!accept.includes('text/markdown')) return;   // pass through to static file

  const tokens = Math.ceil(MARKDOWN.length / 4);   // rough estimate

  return new Response(MARKDOWN, {
    status: 200,
    headers: {
      'Content-Type':    'text/markdown; charset=utf-8',
      'Vary':            'Accept',
      'x-markdown-tokens': String(tokens),
      'Cache-Control':   'public, max-age=3600',
    },
  });
}
