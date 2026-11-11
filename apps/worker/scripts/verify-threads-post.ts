/**
 * Verifikasi penerbitan Threads melawan fake Threads API.
 *
 * Threads memakai host dan versi terpisah (`graph.threads.net/v1.0`)
 * serta pola container dua tahap seperti Instagram, tetapi teks boleh
 * berdiri sendiri. Harness ini membuktikan pemilihan host/versi, body
 * container teks/gambar/karousel, pembacaan status, `threads_publish`,
 * dan pemetaan error — tanpa jaringan atau kredensial.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:threads-post
 */
import {
  ThreadsGraphClient,
  ThreadsGraphError,
} from "@sahabat-kreator/channel-messenger";

let passes = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passes += 1;
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`GAGAL ${label}${detail ? ` (${detail})` : ""}`);
  }
}

interface Captured {
  url: string;
  json: Record<string, unknown> | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(captured: Captured[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    captured.push({ url, json });
    if (url.includes("fields=status")) {
      return jsonResponse({ status: "FINISHED" });
    }
    if (url.endsWith("/threads_publish")) {
      return jsonResponse({ id: "threads_post_1" });
    }
    if (url.endsWith("/threads")) {
      if (json?.is_carousel_item === true) {
        return jsonResponse({ id: `child_${captured.length}` });
      }
      if (json?.media_type === "CAROUSEL") {
        return jsonResponse({ id: "carousel_1" });
      }
      return jsonResponse({ id: "container_1" });
    }
    return jsonResponse({ error: { code: 803, message: "unknown" } }, 404);
  }) as typeof fetch;
}

const USER_ID = "th_user_123";

async function main(): Promise<void> {
  {
    const captured: Captured[] = [];
    const client = new ThreadsGraphClient({
      accessToken: "token-uji",
      fetchImpl: fakeFetch(captured),
    });
    const container = await client.createThreadsContainer({
      threadsUserId: USER_ID,
      mediaType: "TEXT",
      text: "Halo Threads",
    });
    const status = await client.getThreadsContainerStatus(container.containerId);
    const published = await client.publishThreadsContainer({
      threadsUserId: USER_ID,
      containerId: container.containerId,
    });
    check(
      "Threads teks: graph.threads.net/v1.0 + container → FINISHED → publish",
      captured[0]?.url ===
        `https://graph.threads.net/v1.0/${USER_ID}/threads` &&
        status === "FINISHED" &&
        published.providerPostId === "threads_post_1",
      captured[0]?.url,
    );
    check(
      "Threads teks: body media_type/text dan creation_id",
      captured[0]?.json?.media_type === "TEXT" &&
        captured[0]?.json?.text === "Halo Threads" &&
        captured.at(-1)?.json?.creation_id === "container_1",
      JSON.stringify(captured.map((request) => request.json)),
    );
  }

  {
    const captured: Captured[] = [];
    const client = new ThreadsGraphClient({
      accessToken: "token-uji",
      fetchImpl: fakeFetch(captured),
    });
    await client.createThreadsContainer({
      threadsUserId: USER_ID,
      mediaType: "IMAGE",
      imageUrl: "https://cdn.example.test/media/photo.jpg",
      text: "Foto Threads",
    });
    check(
      "Threads gambar: image_url + text",
      captured[0]?.json?.media_type === "IMAGE" &&
        captured[0]?.json?.image_url ===
          "https://cdn.example.test/media/photo.jpg" &&
        captured[0]?.json?.text === "Foto Threads",
      JSON.stringify(captured[0]?.json),
    );
  }

  {
    const captured: Captured[] = [];
    const client = new ThreadsGraphClient({
      accessToken: "token-uji",
      fetchImpl: fakeFetch(captured),
    });
    const childA = await client.createThreadsContainer({
      threadsUserId: USER_ID,
      mediaType: "IMAGE",
      imageUrl: "https://cdn.example.test/media/a.jpg",
      isCarouselItem: true,
    });
    const childB = await client.createThreadsContainer({
      threadsUserId: USER_ID,
      mediaType: "VIDEO",
      videoUrl: "https://cdn.example.test/media/b.mp4",
      isCarouselItem: true,
    });
    const carousel = await client.createThreadsContainer({
      threadsUserId: USER_ID,
      mediaType: "CAROUSEL",
      children: [childA.containerId, childB.containerId],
      text: "Karousel Threads",
    });
    check(
      "Threads karousel: item ditandai, induk membawa children + text",
      carousel.containerId === "carousel_1" &&
        captured[0]?.json?.is_carousel_item === true &&
        captured[1]?.json?.is_carousel_item === true &&
        captured[2]?.json?.children ===
          `${childA.containerId},${childB.containerId}` &&
        captured[2]?.json?.text === "Karousel Threads",
      JSON.stringify(captured.map((request) => request.json)),
    );
  }

  {
    const client = new ThreadsGraphClient({
      accessToken: "token-uji",
      fetchImpl: async () =>
        jsonResponse(
          { error: { code: 190, message: "Invalid OAuth access token" } },
          400,
        ),
    });
    let caught: unknown;
    try {
      await client.createThreadsContainer({
        threadsUserId: USER_ID,
        mediaType: "TEXT",
        text: "gagal",
      });
    } catch (err) {
      caught = err;
    }
    check(
      "Threads error: ThreadsGraphError graph_190 tanpa token",
      caught instanceof ThreadsGraphError &&
        caught.graphCode === 190 &&
        !caught.message.includes("token-uji"),
      caught instanceof Error ? caught.message : String(caught),
    );
  }

  console.log(`\nverify-threads-post: ${passes} PASS, ${failures} FAIL`);
  if (failures > 0) process.exitCode = 1;
}

await main();
