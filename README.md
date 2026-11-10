# Class Live

Live at https://classlive.scienceworks.xyz

- `site/` — the website (Cloudflare Pages). `public/` is the pages; `functions/` passes /api, /ws and /img to the server through the `SERVER` service binding.
- `server/` — the Worker `class-live`. A Durable Object holds lessons, images, votes, the roster of login codes and the teacher sign-in.

Pushing to `main` deploys both through Cloudflare's GitHub connection.

Student logins are codes like `504cloud`. The server stores codes only, never names. Names stay on the teacher's computer: the desktop teacher page (`/skydesk`) opens a name file and keeps it in that browser.

Secrets (like `RESET_KEY`) are set in Cloudflare, never in this repo.
