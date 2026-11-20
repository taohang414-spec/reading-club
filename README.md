# Reading Club — English Reading Check-in

A single-service web app for two students (Isabella, Tata) and one foreign teacher.
All UI text is in English with a gentle blue & yellow theme.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000 (or the `PORT` you set).

## Accounts (default passwords)

| Name | Password | Role |
|---|---|---|
| Isabella | `isabella123` | Student |
| Tata | `tata123` | Student |
| Teacher | `teacher123` | Teacher |

Passwords can be overridden at first start with `ISABELLA_PASSWORD`, `TATA_PASSWORD`,
`TEACHER_PASSWORD`, and changed later in **Settings** inside the app.

> Change the default passwords before sharing the site. Set `SESSION_SECRET` to a
> long random value in production.

## Features

- Students record reading audio in the browser and **cannot upload under 10 minutes** — enforced both client-side (timer) and server-side (audio metadata + declared duration).
- Each student has a dedicated reading board; the teacher can switch boards quickly.
- Students can view each other's recordings and feedback.
- Teacher leaves **text and/or voice feedback**, gives 1–5 stars and positive-feedback badges; feedback syncs to open pages via Server-Sent Events.
- Weekly check-in counts **distinct days with a valid recording**; goal is 5 days per week.
- On **Sunday from 08:00**, each student's own page shows a reminder banner with the week's completion status.
- Data (users, recordings, feedback) is stored in `data/db.json`; audio files in `data/audio/`. Both persist across restarts and survive a redeploy of the same directory.

## Notes

- Recording requires microphone permission and a secure context (HTTPS) when accessed remotely. Localhost is treated as secure.
- The app runs as a single Node HTTP service and listens on `0.0.0.0:$PORT`.
- To reset all data, stop the app and delete `data/db.json` and the contents of `data/audio/`; accounts are recreated on next start.
