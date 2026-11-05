import { describe, expect, it } from "vitest";
import {
  agentRespondJobId,
  automationEvaluateJobId,
  broadcastDispatchJobId,
  flowStepJobId,
  invitationEmailJobId,
  kbEmbedJobId,
  sequenceStepJobId,
} from "./index";

/**
 * Idempotensi antrean bergantung pada satu sifat: jobId untuk peristiwa
 * yang SAMA harus SELALU sama. Kalau salah satu helper berubah bentuk
 * (mis. menambahkan timestamp atau urutan acak), relay akan membuat job
 * duplikat dan kontak bisa menerima pesan yang sama dua kali.
 *
 * Test ini mengunci bentuk string itu — bukan karena string-nya suci,
 * tapi karena perubahan bentuknya adalah perubahan perilaku.
 */
describe("jobId deterministik", () => {
  const eventId = "0f8fad5b-d9cb-469f-a165-70867728950e";

  it("id event outbox menghasilkan jobId yang sama setiap kali dipanggil", () => {
    expect(automationEvaluateJobId(eventId)).toBe(automationEvaluateJobId(eventId));
    expect(automationEvaluateJobId(eventId)).toBe(`automation-evaluate-${eventId}`);
    expect(kbEmbedJobId(eventId)).toBe(`kb-embed-${eventId}`);
    expect(invitationEmailJobId(eventId)).toBe(`invitation-email-${eventId}`);
  });

  it("jobId berbeda untuk peristiwa berbeda", () => {
    const other = "1f8fad5b-d9cb-469f-a165-70867728950f";
    expect(automationEvaluateJobId(eventId)).not.toBe(automationEvaluateJobId(other));
  });

  it("langkah sequence membedakan posisi", () => {
    const enrollment = "enr-1";
    expect(sequenceStepJobId(enrollment, 1)).toBe("seq-enr-1-1");
    expect(sequenceStepJobId(enrollment, 2)).not.toBe(sequenceStepJobId(enrollment, 1));
  });

  it("jobId tetap stabil untuk id yang mengandung tanda hubung", () => {
    // Id pesan/run berasal dari uuid, tapi id turunan (mis. dari provider)
    // bisa mengandung '-'. Bentuk jobId tidak boleh ambigu terhadap itu.
    expect(agentRespondJobId("wa-628123-456")).toBe("agent-respond-wa-628123-456");
    expect(flowStepJobId("run-abc", 7)).toBe("flow-run-abc-7");
    expect(broadcastDispatchJobId("bc-1")).toBe("broadcast-bc-1");
  });
});
