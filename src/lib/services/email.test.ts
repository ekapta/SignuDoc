import assert from "node:assert/strict";
import { test } from "node:test";

import type { Resend } from "resend";

import {
  canSendEmail,
  createEmailService,
  createLazyEmailService,
  readSmtpConfig,
  type EmailService,
} from "./email.ts";

// What the Resend client is asked to do when the service turns a request
// away for rate. Nothing here talks to Resend.

type Answer = {
  data: { id: string } | null;
  error: { message: string; name: string; statusCode: number } | null;
  headers: Record<string, string> | null;
};

const RATE_LIMITED: Answer = {
  data: null,
  error: {
    message:
      "Too many requests. Please limit the number of requests per second.",
    name: "rate_limit_exceeded",
    statusCode: 429,
  },
  headers: { "retry-after": "1" },
};

const SENT: Answer = { data: { id: "email_1" }, error: null, headers: {} };

const MESSAGE = {
  subject: "Your signed copy",
  template: "completion_notification" as const,
  textBody: "Attached.",
  to: "signer@example.test",
};

/** An email service whose Resend client gives these answers, in order. */
function serviceAnswering(answers: Answer[]) {
  const waits: number[] = [];
  let requests = 0;
  const next = async () => {
    const answer = answers[Math.min(requests, answers.length - 1)];

    requests += 1;

    return answer;
  };
  const service = createEmailService({
    resendClient: {
      batch: { send: next },
      emails: { send: next },
    } as unknown as Resend,
    resolveAddresses: async () => ({
      senderAddress: "Example <hello@example.test>",
      supportAddress: null,
    }),
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });

  return { requests: () => requests, service, waits };
}

test("a message Resend turns away for rate is sent again after the wait it names", async () => {
  const { requests, service, waits } = serviceAnswering([
    RATE_LIMITED,
    { ...RATE_LIMITED, headers: { "retry-after": "2" } },
    SENT,
  ]);

  const delivery = await service.send(MESSAGE);

  assert.equal(delivery.messageId, "email_1");
  assert.equal(requests(), 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test("a rate limit that does not clear is reported after a few tries", async () => {
  const { requests, service, waits } = serviceAnswering([RATE_LIMITED]);

  await assert.rejects(service.send(MESSAGE), /Too many requests/);
  // The first try and three more.
  assert.equal(requests(), 4);
  assert.equal(waits.length, 3);
});

test("the wait is a second when Resend names none, and is never long", async () => {
  const { service, waits } = serviceAnswering([
    { ...RATE_LIMITED, headers: null },
    { ...RATE_LIMITED, headers: { "retry-after": "3600" } },
    SENT,
  ]);

  await service.send(MESSAGE);

  assert.deepEqual(waits, [1000, 5000]);
});

test("a used-up quota is reported at once: waiting a second does not bring it back", async () => {
  const { requests, service, waits } = serviceAnswering([
    {
      data: null,
      error: {
        message: "You have exceeded your daily email sending quota.",
        name: "daily_quota_exceeded",
        statusCode: 429,
      },
      headers: { "retry-after": "1" },
    },
  ]);

  await assert.rejects(service.send(MESSAGE), /daily email sending quota/);
  assert.equal(requests(), 1);
  assert.deepEqual(waits, []);
});

test("a batch turned away for rate is sent again too", async () => {
  const { requests, service } = serviceAnswering([
    RATE_LIMITED,
    {
      data: { data: [{ id: "email_1" }] } as unknown as { id: string },
      error: null,
      headers: {},
    },
  ]);

  const deliveries = await service.sendBatch([MESSAGE]);

  assert.equal(deliveries[0]?.messageId, "email_1");
  assert.equal(requests(), 2);
});

test("a lazy email service is only built when it first sends, and only once", async () => {
  let built = 0;
  const service = createLazyEmailService(() => {
    built += 1;

    return {
      async send(message) {
        return { accepted: [message.to], messageId: "m-1", rejected: [] };
      },
      async sendBatch() {
        return [];
      },
    } satisfies EmailService;
  });

  assert.equal(built, 0);
  await service.send(MESSAGE);
  await service.sendBatch([MESSAGE]);
  assert.equal(built, 1);
});

test("a lazy email service with no provider fails the send, not its creation (issue #96)", async () => {
  const service = createLazyEmailService(() => createEmailService({ env: {} }));

  await assert.rejects(service.send(MESSAGE), /RESEND_API_KEY/);
});

test("signup knows when there is no email provider to send with (issue #95)", () => {
  assert.equal(canSendEmail({ NODE_ENV: "production" }), false);
  assert.equal(
    canSendEmail({ NODE_ENV: "production", RESEND_API_KEY: "re_test" }),
    true,
  );
  assert.equal(
    canSendEmail({ EMAIL_DRIVER: "capture", NODE_ENV: "development" }),
    true,
  );
  // The capture driver drops mail, so a real site cannot count on it.
  assert.equal(
    canSendEmail({
      APP_URL: "https://sign.example.com",
      EMAIL_DRIVER: "capture",
      NODE_ENV: "production",
    }),
    false,
  );
});

// The SMTP driver, with a fake transport in place of a mail server.

type SentMail = Record<string, unknown>;

function smtpService(
  answer: (mail: SentMail) => { accepted: string[]; rejected: string[] },
  senderAddress = "Example <hello@example.test>",
) {
  const sent: SentMail[] = [];
  const service = createEmailService({
    env: { EMAIL_DRIVER: "smtp", SMTP_HOST: "smtp.example.test" },
    resolveAddresses: async () => ({
      senderAddress,
      supportAddress: "help@example.test",
    }),
    smtpTransport: {
      sendMail: (async (mail: SentMail) => {
        sent.push(mail);

        return { ...answer(mail), messageId: `<${String(sent.length)}@x>` };
      }) as never,
    },
  });

  return { sent, service };
}

const acceptAll = (mail: SentMail) => ({
  accepted: [String(mail.to)],
  rejected: [],
});

test("SMTP sends the message, its attachments and reply-to address", async () => {
  const { sent, service } = smtpService(acceptAll);
  const result = await service.send({
    ...MESSAGE,
    attachments: [
      {
        content: new Uint8Array([1, 2, 3]),
        contentType: "application/pdf",
        filename: "signed.pdf",
      },
    ],
    htmlBody: "<p>Attached.</p>",
  });

  assert.deepEqual(result, {
    accepted: ["signer@example.test"],
    messageId: "<1@x>",
    rejected: [],
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, "Example <hello@example.test>");
  assert.equal(sent[0].to, "signer@example.test");
  assert.equal(sent[0].replyTo, "help@example.test");
  assert.equal(sent[0].html, "<p>Attached.</p>");
  assert.deepEqual(
    (sent[0].attachments as { filename: string }[]).map((a) => a.filename),
    ["signed.pdf"],
  );
});

test("SMTP sends a batch one message at a time", async () => {
  const { sent, service } = smtpService(acceptAll);
  const results = await service.sendBatch([
    { ...MESSAGE, to: "a@example.test" },
    { ...MESSAGE, to: "b@example.test" },
  ]);

  assert.deepEqual(
    results.map((result) => result.accepted),
    [["a@example.test"], ["b@example.test"]],
  );
  assert.equal(sent.length, 2);
});

test("SMTP fails a message the server refuses", async () => {
  const { service } = smtpService((mail) => ({
    accepted: [],
    rejected: [String(mail.to)],
  }));

  await assert.rejects(service.send(MESSAGE), /refused the message/);
});

test("SMTP will not send from Resend's shared test address", async () => {
  const { sent, service } = smtpService(
    acceptAll,
    "Example <onboarding@resend.dev>",
  );

  await assert.rejects(
    service.send(MESSAGE),
    /Set the address email is sent from/,
  );
  assert.equal(sent.length, 0);
});

test("SMTP settings are read from the environment", () => {
  assert.deepEqual(readSmtpConfig({ SMTP_HOST: "smtp.kku.ac.th" }), {
    host: "smtp.kku.ac.th",
    port: 587,
    requireTLS: false,
    secure: false,
    tls: { rejectUnauthorized: true },
  });
  assert.deepEqual(
    readSmtpConfig({
      SMTP_HOST: "smtp.example.test",
      SMTP_PASS: "secret",
      SMTP_PORT: "465",
      SMTP_REQUIRE_TLS: "true",
      SMTP_TLS_REJECT_UNAUTHORIZED: "false",
      SMTP_USER: "mailer",
    }),
    {
      auth: { pass: "secret", user: "mailer" },
      host: "smtp.example.test",
      port: 465,
      requireTLS: true,
      secure: true,
      tls: { rejectUnauthorized: false },
    },
  );
  assert.throws(() => readSmtpConfig({}), /SMTP_HOST/);
  assert.throws(
    () => readSmtpConfig({ SMTP_HOST: "x", SMTP_PORT: "abc" }),
    /SMTP_PORT/,
  );
  assert.throws(
    () => readSmtpConfig({ SMTP_HOST: "x", SMTP_SECURE: "maybe" }),
    /SMTP_SECURE/,
  );
});

test("SMTP counts as able to send only once SMTP_HOST is set", () => {
  assert.equal(canSendEmail({ EMAIL_DRIVER: "smtp" }), false);
  assert.equal(
    canSendEmail({ EMAIL_DRIVER: "smtp", SMTP_HOST: "smtp.example.test" }),
    true,
  );
});
