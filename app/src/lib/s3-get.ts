// Server side only (the backend route). Fetches an output the handler left on S3 when the store has no presigned
// links (Runpod's network-volume S3 answers them with 403): a GET signed with AWS Signature V4 in the headers.
//   s3://<bucket>/<key>?endpoint=https://s3api-eu-ro-1.runpod.io&region=eu-ro-1
import { createHash, createHmac } from "node:crypto";

export interface S3Location {
  endpoint: URL;
  region: string;
  bucket: string;
  key: string;
}

export function parseS3Url(value: string): S3Location {
  const u = new URL(value);
  if (u.protocol !== "s3:") throw new Error("not an s3:// URL");
  const endpoint = new URL(u.searchParams.get("endpoint") || "");
  if (endpoint.protocol !== "https:") throw new Error("the S3 endpoint must be https");
  const key = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
  if (!u.hostname || !key) throw new Error("s3:// URL without bucket or key");
  return { endpoint, region: u.searchParams.get("region") || "us-east-1", bucket: u.hostname, key };
}

const encode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (key: string | Buffer, s: string) => createHmac("sha256", key).update(s).digest();

export function s3Get(loc: S3Location, accessKey: string, secretKey: string, signal?: AbortSignal): Promise<Response> {
  const path = `/${encode(loc.bucket)}/${loc.key.split("/").map(encode).join("/")}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payload = sha256("");
  const signed = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["GET", path, "",
    `host:${loc.endpoint.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${amzDate}\n`, signed, payload].join("\n");
  const scope = `${day}/${loc.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), loc.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  return fetch(loc.endpoint.origin + path, {
    headers: {
      "x-amz-content-sha256": payload,
      "x-amz-date": amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    },
    signal,
  });
}
