import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Buffer } from "buffer";
import sharp from "sharp";
import { Args, resizeBuffer, getS3File, Config, parseBooleanArg } from "./lib.js";
import { URLSearchParams } from "url";

const streamify_handler: StreamifyHandler = async (event, response) => {
  const region = process.env.S3_REGION!;
  const bucket = process.env.S3_BUCKET!;
  const config: Config = {
    region: region,
    bucket: bucket,
  };
  if (process.env.S3_ENDPOINT) {
    config.endpoint = process.env.S3_ENDPOINT;
  }
  if (process.env.S3_FORCE_PATH_STYLE) {
    config.forcePathStyle = true;
  }
  const key = decodeURIComponent(event.rawPath.substring(1)).replace(
    "/tachyon/",
    "/"
  );
  const args = (event.queryStringParameters || {}) as unknown as Args & {
    "X-Amz-Expires"?: string;
    presign?: string;
    key: string;
    original?: string;
  };
  args.key = key;
  const original =
    typeof args.original !== "undefined" && parseBooleanArg(args.original);
  // Serve WebP by default. `original` forces the source format, and an
  // explicit `webp` arg is respected and validated in resizeBuffer.
  if (original) {
    args.webp = false;
  } else if (typeof args.webp === "undefined") {
    args.webp = true;
  }
  // If there is a presign param, we need to decode it and add it to the args.
  if (args.presign) {
    const presignArgs = new URLSearchParams(args.presign);
    for (const [key, value] of presignArgs.entries()) {
      args[key as keyof Args] = value;
    }
    delete args.presign;
  }

  const originalUrl = `${process.env.DOMAIN}/${key}`;
  const isPresigned = !!args["X-Amz-Algorithm"];
  let buffer: Buffer | undefined;

  try {
    const s3Response = await getS3File(config, key, args);
    if (s3Response.Body === undefined) {
      throw new Error("Not found");
    }
    buffer = Buffer.from(await s3Response.Body.transformToByteArray());
  } catch (error: any) {
    // AccessDenied also means "missing" when the role cannot list the
    // bucket. A presigned request that fails must not fall back to the
    // public origin.
    const isMissing =
      error.Code === "NoSuchKey" || error.Code === "AccessDenied";
    if (!isMissing || isPresigned) {
      if (isMissing) {
        return sendText(response, 404, "File not found.");
      }
      console.error(error);
      return sendText(response, 502, "Bad gateway.");
    }

    let fetchResponse: Response;
    try {
      fetchResponse = await fetch(originalUrl);
    } catch (e) {
      console.error(e);
      return sendText(response, 502, "Bad gateway.");
    }
    if (fetchResponse.status === 404) {
      return sendText(response, 404, "File not found.");
    }
    if (!fetchResponse.ok) {
      console.error(`Origin returned ${fetchResponse.status} for ${originalUrl}`);
      return sendText(response, 502, "Bad gateway.");
    }
    buffer = Buffer.from(await fetchResponse.arrayBuffer());

    // Only cache real images, so an origin error page is never stored.
    if (await isImage(buffer)) {
      try {
        const { bucket: _bucket, ...clientConfig } = config;
        const s3Client = new S3Client(clientConfig);
        await s3Client.send(
          new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer })
        );
      } catch (e) {
        // Caching is best effort; still serve the image.
        console.error(e);
      }
    }
  }

  try {
    const { info, data } = await resizeBuffer(buffer, args);
    buffer = undefined;
    response = awslambda.HttpResponseStream.from(response, {
      statusCode: 200,
      headers: {
        "Cache-Control": `max-age=${getMaxAge(args)}`,
        "Last-Modified": new Date().toUTCString(),
        // sharp reports AVIF output as "heif".
        "Content-Type": "image/" + (info.format === "heif" ? "avif" : info.format),
      },
    });
    response.write(data);
    response.end();
  } catch (e: any) {
    console.error(e);
    sendText(response, 500, "Internal server error.");
  }
};

/**
 * Send a plain text response.
 */
function sendText(response: ResponseStream, statusCode: number, body: string): void {
  response = awslambda.HttpResponseStream.from(response, {
    statusCode,
    headers: {
      "Content-Type": "text/html",
    },
  });
  response.write(body);
  response.end();
}

/**
 * Whether sharp can read a buffer as an image.
 */
async function isImage(buffer: Buffer): Promise<boolean> {
  try {
    const metadata = await sharp(buffer).metadata();
    return !!metadata.format;
  } catch {
    return false;
  }
}

/**
 * Cache for a year, or until a presigned URL expires.
 */
export function getMaxAge(args: Args, now: number = Date.now()): number {
  const year = 31536000;
  if (!args["X-Amz-Expires"] || !args["X-Amz-Date"]) {
    return year;
  }
  // X-Amz-Date is YYYYMMDDTHHMMSSZ, which Date cannot parse.
  const signedAt = Date.parse(
    args["X-Amz-Date"].replace(
      /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,
      "$1-$2-$3T$4:$5:$6Z"
    )
  );
  const expiresAt = signedAt / 1000 + Number(args["X-Amz-Expires"]);
  const maxAge = Math.floor(expiresAt - now / 1000);
  if (!Number.isFinite(maxAge)) {
    return 0;
  }
  return Math.min(Math.max(maxAge, 0), year);
}

// Outside Lambda, shim the streaming API. Check the method, not the
// global: @aws/lambda-invoke-store (an AWS SDK dependency) sets
// `globalThis.awslambda = {}` at import time.
if (typeof globalThis.awslambda?.streamifyResponse !== "function") {
  global.awslambda = {
    ...globalThis.awslambda,
    streamifyResponse(handler: StreamifyHandler): StreamifyHandler {
      return handler;
    },
    HttpResponseStream: {
      from(
        response: ResponseStream,
        metadata: {
          headers?: Record<string, string>;
        }
      ): ResponseStream {
        response.metadata = metadata;
        return response;
      },
    },
  };
}

export const handler = awslambda.streamifyResponse(streamify_handler);
