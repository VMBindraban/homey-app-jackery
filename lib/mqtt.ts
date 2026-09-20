import net from 'net';

type Log = (...args: any[]) => void;
export type MqttMessageHandler = (topic: string, message: any) => void;

export interface MqttOptions {
  host: string;
  port: number | string;
  username?: string;
  password?: string;
}

function encStr(value: unknown): Buffer {
  const buffer = Buffer.from(String(value), 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(buffer.length);
  return Buffer.concat([length, buffer]);
}

function encodeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let number = value;

  do {
    let digit = number % 128;
    number = Math.floor(number / 128);
    if (number > 0) digit |= 128;
    bytes.push(digit);
  } while (number > 0);

  return Buffer.from(bytes);
}

function packet(type: number, payload: Buffer, flags = 0): Buffer {
  return Buffer.concat([
    Buffer.from([(type << 4) | flags]),
    encodeVarInt(payload.length),
    payload,
  ]);
}

export class MqttLite {
  private readonly log: Log;
  private readonly options: MqttOptions;
  private readonly onMessage: MqttMessageHandler;
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private messageId = 1;
  private timer: NodeJS.Timeout | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private closing = false;
  onClose: (() => void) | null = null;

  constructor(log: Log, options: MqttOptions, onMessage: MqttMessageHandler) {
    this.log = log;
    this.options = options;
    this.onMessage = onMessage;
  }

  private settleConnect(error?: Error): void {
    const resolve = this.resolveConnect;
    const reject = this.rejectConnect;
    this.resolveConnect = null;
    this.rejectConnect = null;
    if (error) reject?.(error); else resolve?.();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;

      this.socket = net.createConnection({
        host: this.options.host,
        port: Number(this.options.port),
      }, () => {
        const { username, password } = this.options;
        let flags = 0x02; // clean session
        const payload: Buffer[] = [encStr(`homey-jackery-${process.pid}-${Date.now() % 100000}`)];
        if (username) { flags |= 0x80; payload.push(encStr(username)); }
        if (password) { flags |= 0x40; payload.push(encStr(password)); }

        const variableHeader = Buffer.concat([
          encStr('MQTT'),
          Buffer.from([4, flags, 0, 60]),
        ]);

        this.socket?.write(packet(1, Buffer.concat([variableHeader, ...payload])));
      });

      this.socket.on('data', data => this.handleData(Buffer.from(data as Uint8Array)));
      this.socket.on('error', error => {
        this.settleConnect(error);
        this.log('MQTT error', error.message);
      });
      this.socket.on('close', () => {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.settleConnect(new Error('connection closed'));
        this.log('MQTT disconnected');
        if (!this.closing) this.onClose?.();
      });
    });
  }

  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (this.buffer.length >= 2) {
      let index = 1;
      let remainingLength = 0;
      let multiplier = 1;
      let completeLength = false;

      while (index < this.buffer.length) {
        const byte = this.buffer[index++];
        remainingLength += (byte & 127) * multiplier;

        if ((byte & 128) === 0) {
          completeLength = true;
          break;
        }

        multiplier *= 128;
        if (multiplier > 128 * 128 * 128 * 128) {
          this.log('Invalid MQTT remaining length');
          this.close();
          return;
        }
      }

      if (!completeLength || this.buffer.length < index + remainingLength) return;

      const packetTypeAndFlags = this.buffer[0];
      const type = packetTypeAndFlags >> 4;
      const payload = this.buffer.subarray(index, index + remainingLength);
      this.buffer = this.buffer.subarray(index + remainingLength);

      if (type === 2) {
        const rc = payload[1];
        if (rc !== 0) {
          this.settleConnect(new Error(`CONNACK refused, code ${rc}`));
          this.close();
          return;
        }
        this.timer = setInterval(() => this.socket?.write(packet(12, Buffer.alloc(0))), 30000);
        this.settleConnect();
      } else if (type === 3) {
        if (payload.length < 2) continue;

        const topicLength = payload.readUInt16BE(0);
        const topicEnd = 2 + topicLength;
        if (payload.length < topicEnd) continue;

        const topic = payload.subarray(2, topicEnd).toString();
        let position = topicEnd;
        const qos = (packetTypeAndFlags >> 1) & 0x03;

        if (qos === 1) position += 2;
        if (position > payload.length) continue;

        const message = payload.subarray(position).toString();
        let parsed: any = null;
        try {
          parsed = JSON.parse(message);
        } catch {
          this.log('MQTT JSON parse error on', topic);
        }
        this.onMessage(topic, parsed);
      }
    }
  }

  subscribe(topic: string): void {
    if (!this.socket) return;

    const id = (this.messageId++ % 65535) || 1;
    const payload = Buffer.concat([
      Buffer.from([id >> 8, id & 255]),
      encStr(topic),
      Buffer.from([0]),
    ]);

    this.socket.write(packet(8, payload, 0x02));
  }

  publish(topic: string, object: Record<string, any>): void {
    if (!this.socket) return;

    const payload = Buffer.concat([
      encStr(topic),
      Buffer.from(JSON.stringify(object)),
    ]);

    this.socket.write(packet(3, payload));
  }

  close(): void {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.socket?.end();
    this.socket = null;
  }
}
