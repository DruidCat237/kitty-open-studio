# Hosted demo: a link that runs on your serverless endpoint

One deployment of the web app that anyone with the link can try, on your own Runpod serverless endpoint, without
ever seeing your keys. Useful for judges, testers or a client.

How it works:

- The Runpod API key, the endpoint id and the S3 keys live only in the server's environment. The browser gets an
  access code (from the link) and sends jobs to the app's own server, which adds the key and calls Runpod.
- Without the right code the server refuses every job (401). Wrong codes are compared in constant time.
- Only the cards in `KITTY_HOSTED_WORKFLOWS` are shown and accepted; a daily limit (`KITTY_HOSTED_MAX_JOBS`) caps the
  cost. The prompt filter applies as everywhere else.
- Results are fetched only from `outputs/` on your S3 endpoint; the demo cannot read the models or anything else.
- The code leaves the address bar as soon as the page opens. Give the link only to the people it is for.

## Deploy on a Runpod CPU pod

1. **The endpoint** (see [runpod.md](runpod.md#b-serverless-endpoint-on-the-same-volume)): set **Max workers** to 1
   or 2 and a short idle timeout, so a burst of clicks cannot start many GPUs. Keep FlashBoot on.
2. **Secrets** (Runpod → Secrets): the API key and the S3 key pair, for example `kitty_runpod_key`,
   `kitty_s3_access`, `kitty_s3_secret`.
3. **A CPU pod** (4 vCPU, 8 GB is enough), image `node:22-bookworm`, HTTP port **3000**, start command:

   ```bash
   bash -c "apt-get update -qq && apt-get install -y -qq git && git clone --depth 1 https://github.com/DruidCat237/kitty-open-studio /srv/kitty && bash /srv/kitty/app/scripts/hosted-demo.sh"
   ```

   Environment variables:

   | Variable | Value |
   |---|---|
   | `KITTY_HOSTED_ACCESS` | a long random code, e.g. from `openssl rand -hex 16` |
   | `KITTY_HOSTED_ENDPOINT` | the endpoint id |
   | `RUNPOD_API_KEY` | `{{ RUNPOD_SECRET_kitty_runpod_key }}` |
   | `S3_ENDPOINT` (only with `OUTPUT_MODE=s3`) | your volume's S3 endpoint, e.g. `https://s3api-eu-ro-1.runpod.io` |
   | `S3_ACCESS_KEY` / `S3_SECRET_KEY` | `{{ RUNPOD_SECRET_kitty_s3_access }}` / `{{ RUNPOD_SECRET_kitty_s3_secret }}` |
   | `KITTY_HOSTED_WORKFLOWS` | the cards to offer, e.g. `flux3-klein,flux3-klein-edit,qwen-image-t2i,qwen-image-edit` |
   | `KITTY_HOSTED_MAX_JOBS` | jobs per day, e.g. `40` |

   The first start installs and builds the app (about 5 minutes).
4. **The link**: `https://<pod id>-3000.proxy.runpod.net/en?demo=<KITTY_HOSTED_ACCESS>`. Open it once yourself and
   run one card.
5. **To end the demo**: stop or delete the CPU pod, or change `KITTY_HOSTED_ACCESS` (old links stop working).

Any other Node host works the same way: run `bash app/scripts/hosted-demo.sh` with the variables above set.
