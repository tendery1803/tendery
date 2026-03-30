import * as net from "node:net";
import * as readline from "node:readline";
import * as tls from "node:tls";

function smtpTlsRejectUnauthorized(): boolean {
  const v = (process.env.SMTP_TLS_REJECT_UNAUTHORIZED ?? "true").toLowerCase();
  return v !== "false" && v !== "0";
}

function extractAddr(fromHeader: string): string {
  const m = /<([^>]+)>/.exec(fromHeader);
  if (m) return m[1].trim();
  return fromHeader.trim();
}

/** Один итератор на соединение — у readline нельзя открывать несколько asyncIterator. */
class SmtpLineReader {
  private readonly it: AsyncIterator<string>;

  constructor(rl: readline.Interface) {
    this.it = rl[Symbol.asyncIterator]();
  }

  async readOneResponse(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      const { value: line, done } = await this.it.next();
      if (done || line == null) {
        throw new Error("SMTP: unexpected EOF");
      }
      lines.push(line);
      const code = Number(line.slice(0, 3));
      if (Number.isNaN(code)) {
        throw new Error(`SMTP: bad reply line: ${line}`);
      }
      if (line.length >= 4 && line[3] === " ") {
        return { code, lines };
      }
    }
  }
}

function writeLine(socket: net.Socket | tls.TLSSocket, line: string): void {
  socket.write(`${line}\r\n`);
}

async function smtpCmd(
  socket: net.Socket | tls.TLSSocket,
  reader: SmtpLineReader,
  line: string,
  okCodes: number[]
): Promise<{ code: number; lines: string[] }> {
  writeLine(socket, line);
  const res = await reader.readOneResponse();
  if (!okCodes.includes(res.code)) {
    throw new Error(`SMTP: command failed (${res.code}): ${line} → ${res.lines.join(" | ")}`);
  }
  return res;
}

function dotStuff(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized
    .split("\n")
    .map((l) => (l.startsWith(".") ? `.${l}` : l))
    .join("\r\n");
}

function connectTcp(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port }, () => resolve(s));
    s.setTimeout(60_000);
    s.once("error", reject);
  });
}

function connectTls(host: string, port: number, rejectUnauthorized: boolean): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, servername: host, rejectUnauthorized }, () => resolve(s));
    s.setTimeout(60_000);
    s.once("error", reject);
  });
}

/**
 * Минимальная отправка одного письма по SMTP (AUTH PLAIN, STARTTLS на 587 при необходимости).
 * Без внешних зависимостей.
 */
export async function sendSmtpMail(input: {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const rejectUnauthorized = smtpTlsRejectUnauthorized();
  const host = input.host;
  const port = input.port;

  let socket: net.Socket | tls.TLSSocket = input.secure
    ? await connectTls(host, port, rejectUnauthorized)
    : await connectTcp(host, port);

  let rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
  let reader = new SmtpLineReader(rl);

  try {
    const greeting = await reader.readOneResponse();
    if (greeting.code !== 220) {
      throw new Error(`SMTP: expected 220 greeting, got ${greeting.code}`);
    }

    let ehlo = await smtpCmd(socket, reader, "EHLO tendery", [250]);

    if (!input.secure) {
      const canStartTls = ehlo.lines.some((l) => /STARTTLS/i.test(l));
      if (canStartTls) {
        await smtpCmd(socket, reader, "STARTTLS", [220]);
        rl.close();
        const plain = socket as net.Socket;
        socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
          const s = tls.connect(
            { socket: plain, host, servername: host, rejectUnauthorized },
            () => resolve(s)
          );
          s.setTimeout(60_000);
          s.once("error", reject);
        });
        rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
        reader = new SmtpLineReader(rl);
        await smtpCmd(socket, reader, "EHLO tendery", [250]);
      }
    }

    const user = input.user?.trim();
    if (user) {
      const pass = input.password ?? "";
      const token = Buffer.from(`\0${user}\0${pass}`, "utf-8").toString("base64");
      await smtpCmd(socket, reader, `AUTH PLAIN ${token}`, [235]);
    }

    const fromAddr = extractAddr(input.from);
    const toAddr = extractAddr(input.to);

    await smtpCmd(socket, reader, `MAIL FROM:<${fromAddr}>`, [250]);
    await smtpCmd(socket, reader, `RCPT TO:<${toAddr}>`, [250, 251]);
    await smtpCmd(socket, reader, "DATA", [354]);

    const subject = input.subject.replace(/\r?\n/g, " ");
    const headers =
      `From: ${input.from}\r\n` +
      `To: ${input.to}\r\n` +
      `Subject: ${subject}\r\n` +
      `Content-Type: text/plain; charset=UTF-8\r\n` +
      `\r\n`;

    const body = dotStuff(input.text);
    socket.write(`${headers}${body}\r\n.\r\n`);

    const end = await reader.readOneResponse();
    if (end.code !== 250) {
      throw new Error(`SMTP: DATA failed with ${end.code}: ${end.lines.join(" | ")}`);
    }

    try {
      await smtpCmd(socket, reader, "QUIT", [221]);
    } catch {
      /* сервер мог уже закрыть соединение */
    }
  } finally {
    rl.close();
    socket.end();
  }
}
