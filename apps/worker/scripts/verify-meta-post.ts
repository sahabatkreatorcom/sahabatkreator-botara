/**
 * Verifikasi penerbitan linimasa Meta melawan fake Graph API.
 *
 * Tidak ada jaringan dan tidak ada kredensial: `fetchImpl` mencatat
 * URL/body lalu menjawab bentuk Graph yang terdokumentasi. Yang dijaga:
 *  (a) Facebook Page teks memakai POST /{page-id}/feed;
 *  (b) satu foto memakai multipart /{page-id}/photos published=true;
 *  (c) album mengunggah foto published=false lalu merangkainya lewat
 *      attached_media pada SATU feed;
 *  (d) video memakai multipart /{page-id}/videos dengan description;
 *  (e) Instagram memakai container dua tahap: media/Reels/karousel
 *      dibuat, statusnya dibaca, lalu `media_publish` menerbitkannya;
 *  (f) error Graph tetap menjadi MetaGraphError berkode resmi, tanpa
 *      token pada pesan/log harness.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:meta-post
 */
import {
  MetaGraphClient,
  MetaGraphError,
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
  form: FormData | null;
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
    const form = init?.body instanceof FormData ? init.body : null;
    captured.push({ url, json, form });

    if (url.endsWith("/photos")) {
      const published = form?.get("published");
      return jsonResponse(
        published === "false"
          ? { id: `media_${captured.length}` }
          : { id: "media_single", post_id: "page_post_photo" },
      );
    }
    if (url.includes("fields=status_code")) {
      return jsonResponse({ status_code: "FINISHED" });
    }
    if (url.endsWith("/media_publish")) {
      return jsonResponse({ id: "ig_post_1" });
    }
    if (url.endsWith("/media")) {
      if (json?.is_carousel_item === true) {
        return jsonResponse({ id: `child_${captured.length}` });
      }
      if (json?.media_type === "CAROUSEL") {
        return jsonResponse({ id: "carousel_1" });
      }
      return jsonResponse({ id: "container_1" });
    }
    if (url.endsWith("/videos")) {
      return jsonResponse({ id: "page_video_1" });
    }
    if (url.endsWith("/feed")) {
      return jsonResponse({ id: "page_post_1" });
    }
    return jsonResponse({ error: { code: 803, message: "unknown path" } }, 404);
  }) as typeof fetch;
}

const PAGE_ID = "1234567890";
const IG_ID = "17841400000000000";
const file = (name: string, type = "image/jpeg") => ({
  data: new TextEncoder().encode(`bytes-${name}`),
  filename: name,
  contentType: type,
});

async function main(): Promise<void> {
  {
    const captured: Captured[] = [];
    const client = new MetaGraphClient({
      accessToken: "token-uji",
      fetchImpl: fakeFetch(captured),
    });
    const result = await client.publishPagePost({
      pageId: PAGE_ID,
      message: "Promo hari ini",
    });
    check("FB teks: hasil post id", result.providerPostId === "page_post_1");
    check(
      "FB teks: path /{page}/feed dan body message",
      captured[0]?.url.endsWith(`/v26.0/${PAGE_ID}/feed`) === true &&
        captured[0]?.json?.message === "Promo hari ini",
      captured[0]?.url,
    );
  }

  {
    const captured: Captured[] = [];
    const client = new MetaGraphClient({
      accessToken: "token-uji",
      fetchImpl: fakeFetch(captured),
    });
    const result = await client.publishPagePhotoAlbum({
      pageId: PAGE_ID,
      files: [file("satu.jpg")],
      caption: "Satu foto",
    });
    const source = captured[0]?.form?.get("source");
    check("FB foto: hasil post_id photos", result.providerPostId === "page_post_photo");
    check(
      "FB foto: multipart source + caption + published=true",
      captured[0]?.url.endsWith(`/v26.0/${PAGE_ID}/photos`) === true &&
        source instanceof File &&
        source.name === "satu.jpg" &&
        captured[0]?.form?.get("caption") === "Satu foto" &&
        captured[0]?.form?.get("published") === "true",
    );
  }

  {
    const captured: Captured[] = [];
    const client = new MetaGraphClient({
      accessToken: "token-uji",
      fetchImpl: fakeFetch(captured),
    });
    const result = await client.publishPagePhotoAlbum({
      pageId: PAGE_ID,
      files: [file("a.jpg"), file("b.jpg")],
      caption: "Album promo",
    });
    const feed = captured.find((request) => request.url.endsWith("/feed"));
    const attached = feed?.json?.attached_media as
      | Array<{ media_fbid: string }>
      | undefined;
    check("FB album: hasil feed", result.providerPostId === "page_post_1");
    check(
      "FB album: 2 unggahan unpublished + attached_media berurutan",
      captured.filter((request) => request.url.endsWith("/photos")).length === 2 &&
        captured
          .filter((request) => request.url.endsWith("/photos"))
          .every((request) => request.form?.get("published") === "false") &&
        attached?.length === 2 &&
        attached[0]?.media_fbid !== attached[1]?.media_fbid,
      JSON.stringify(feed?.json),
    );
  }

  {
    const captured: Captured[] = [];
    const client = new MetaGraphClient({
      accessToken: "token-uji",
      fetchImpl: fakeFetch(captured),
    });
    const result = await client.publishPageVideo({
      pageId: PAGE_ID,
      file: file("promo.mp4", "video/mp4"),
      description: "Video promo",
    });
    const source = captured[0]?.form?.get("source");
    check("FB video: hasil id", result.providerPostId === "page_video_1");
    check(
      "FB video: multipart /videos + description",
      captured[0]?.url.endsWith(`/v26.0/${PAGE_ID}/videos`) === true &&
        source instanceof File &&
        source.type === "video/mp4" &&
        captured[0]?.form?.get("description") === "Video promo",
    );
  }

  {
    const captured: Captured[] = [];
    const client = new MetaGraphClient({
      accessToken: "token-uji",
      fetchImpl: fakeFetch(captured),
    });
    const container = await client.createInstagramMediaContainer({
      instagramAccountId: IG_ID,
      imageUrl: "https://cdn.example.test/media/photo.jpg",
      caption: "Halo IG",
    });
    const status = await client.getInstagramContainerStatus(container.containerId);
    const published = await client.publishInstagramContainer({
      instagramAccountId: IG_ID,
      containerId: container.containerId,
    });
    check("IG foto: container → FINISHED → publish", published.providerPostId === "ig_post_1" && status === "FINISHED");
    check(
      "IG foto: body image_url/caption dan creation_id",
      captured[0]?.url.endsWith(`/v26.0/${IG_ID}/media`) === true &&
        captured[0]?.json?.image_url === "https://cdn.example.test/media/photo.jpg" &&
        captured[0]?.json?.caption === "Halo IG" &&
        captured.at(-1)?.json?.creation_id === "container_1",
      JSON.stringify(captured.map((request) => request.json)),
    );
  }

  {
    const captured: Captured[] = [];
    const client = new MetaGraphClient({
      accessToken: "token-uji",
      fetchImpl: fakeFetch(captured),
    });
    await client.createInstagramMediaContainer({
      instagramAccountId: IG_ID,
      videoUrl: "https://cdn.example.test/media/reel.mp4",
      caption: "Reels",
    });
    check(
      "IG video: video_url + media_type REELS",
      captured[0]?.json?.video_url === "https://cdn.example.test/media/reel.mp4" &&
        captured[0]?.json?.media_type === "REELS",
      JSON.stringify(captured[0]?.json),
    );
  }

  {
    const captured: Captured[] = [];
    const client = new MetaGraphClient({
      accessToken: "token-uji",
      fetchImpl: fakeFetch(captured),
    });
    const childA = await client.createInstagramMediaContainer({
      instagramAccountId: IG_ID,
      imageUrl: "https://cdn.example.test/media/a.jpg",
      isCarouselItem: true,
    });
    const childB = await client.createInstagramMediaContainer({
      instagramAccountId: IG_ID,
      videoUrl: "https://cdn.example.test/media/b.mp4",
      isCarouselItem: true,
    });
    const carousel = await client.createInstagramCarouselContainer({
      instagramAccountId: IG_ID,
      children: [childA.containerId, childB.containerId],
      caption: "Karousel campuran",
    });
    check("IG karousel: container induk CAROUSEL", carousel.containerId === "carousel_1");
    check(
      "IG karousel: item tanpa caption; video item bukan REELS; children berurutan",
      captured[0]?.json?.is_carousel_item === true &&
        !("caption" in (captured[0]?.json ?? {})) &&
        captured[1]?.json?.is_carousel_item === true &&
        !("media_type" in (captured[1]?.json ?? {})) &&
        captured[2]?.json?.media_type === "CAROUSEL" &&
        captured[2]?.json?.children === `${childA.containerId},${childB.containerId}`,
      JSON.stringify(captured.map((request) => request.json)),
    );
  }

  {
    const client = new MetaGraphClient({
      accessToken: "token-uji",
      fetchImpl: async () =>
        jsonResponse(
          { error: { code: 190, message: "Invalid OAuth access token" } },
          400,
        ),
    });
    let caught: unknown;
    try {
      await client.publishPagePost({ pageId: PAGE_ID, message: "gagal" });
    } catch (err) {
      caught = err;
    }
    check(
      "FB error: MetaGraphError graph_190 tanpa token",
      caught instanceof MetaGraphError &&
        caught.graphCode === 190 &&
        !caught.message.includes("token-uji"),
      caught instanceof Error ? caught.message : String(caught),
    );
  }

  console.log(`\nverify-meta-post: ${passes} PASS, ${failures} FAIL`);
  if (failures > 0) process.exitCode = 1;
}

await main();
