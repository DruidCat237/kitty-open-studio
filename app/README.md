# Kitty Open Studio app

The desktop and web app of Kitty Open Studio: a Studio with the workflow cards (pick a card, fill it in, generate)
and a timeline editor for putting the results together. Generation runs on your own ComfyUI backend (a Runpod pod,
a serverless endpoint or Docker on your GPU), see the repository's [README](../README.md).

```bash
npm ci
npm run sync-catalog   # copies backend/workflows/index.json and the gallery into the app
npm run dev            # http://localhost:3000
```

Open the backend pill in the header to point the app at a pod, a serverless endpoint or local Docker.
