import { Context, Schema, Session, sleep, User } from "koishi";

export const name = "open-llm-vtuber";

export interface Config {
  ws_url?: string;
  show_reasoning?: boolean;
  remove_emoji?: boolean;
  reasoning_model?: boolean;
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    ws_url: Schema.string()
      .description("ws连接地址，注意端点为/ws-clint")
      .default("ws://127.0.0.1:8080/ws-client"),
    reasoning_model: Schema.boolean()
      .description("是否Reasoning模型")
      .default(false),
  }).description("基础设置"),
  Schema.union([
    Schema.object({
      reasoning_model: Schema.const(true).required(),
      show_reasoning: Schema.boolean()
        .description("对于Reasoning模型是否显示思考过程")
        .default(true),
      remove_emoji: Schema.boolean()
        .description("对于Emoji表情是否移除")
        .default(true),
    }).description("Reasoning模型相关设置"),
    Schema.object({}),
  ]),
]);

export const inject = {
  required: ["http"],
};

interface VtuberMessage {
  type: string;
}

class TextMessage implements VtuberMessage {
  type: string = "text-input";
  text: string;
  images: string[] = [];

  constructor(text: string, images: string[] = []) {
    this.text = text;
    this.images = images;
  }
}

class DisplayText {
  text: string;
  avatar: string;
  name: string;
}

class AudioMessage implements VtuberMessage {
  type: string = "audio";
  audio: string;
  display_text: DisplayText;
}

class AudioPlayStartMessage implements VtuberMessage {
  type: string = "audio-play-start";
  display_text: DisplayText;
  forwarded: boolean;

  constructor(display_text: DisplayText, forwarded: boolean) {
    this.display_text = display_text;
    this.forwarded = forwarded;
  }
}

class ControlMessage implements VtuberMessage {
  type: string = "control";
  text: string;
}

class HistoryCreated implements VtuberMessage {
  type: string = "new-history-created";
  history_uid: string;
}

interface ParseEvent {
  channel: { id: string; type: number };
  platform: string;
}

export function apply(ctx: Context, config: Config) {
  let session_map: Map<
    string,
    [Session<never, never, Context>, WebSocket, string]
  > = new Map();

  ctx
    .command("vtuber")
    .alias("v")
    .option("up", "-p [history_uid] 启动当前会话中的vtuber回复")
    .option("down", "-d 关闭当前会话中的vtuber回复")
    .action(({ session, options }) => {
      const [event, map_key] = get_event_and_key(session);
      if ("up" in options) {
        if (session_map.has(map_key)) {
          const [_, ws, uid] = session_map.get(map_key);
          session_map.set(map_key, [session, ws, uid]);
          return "vtuber 已连接";
        } else {
          const ws = create_ws(ctx, map_key);

          if (options.up) {
            session_map.set(map_key, [session, ws, options.up]);
          } else {
            session_map.set(map_key, [session, ws, ""]);
          }

          return "vtuber 连接中...";
        }
      }
      if (options?.down) {
        const [_, ws] = session_map.get(map_key);
        ws.close();
        ctx.logger.info("Delete session: %s", map_key);
        return "vtuber 断开连接中...";
      }
    });

  function create_ws(ctx: Context, map_key: string) {
    const ws = ctx.http.ws(ctx.config.ws_url);
    let full_text = "";

    ws.addEventListener("open", (event) => {
      const [session, _, uid] = session_map.get(map_key);

      if (uid) {
        ws.send(
          JSON.stringify({
            type: "fetch-and-set-history",
            history_uid: uid,
          })
        );
      } else {
        ws.send(JSON.stringify({ type: "create-new-history" }));
      }

      session.sendQueued("vtuber 连接完毕，可以通话\n");
      ctx.logger.info(
        "WebSocket conencted: {session: %s, url: %s}",
        map_key,
        ws.url
      );
    });

    ws.addEventListener("close", (event) => {
      const [session, _] = session_map.get(map_key);
      session.send("vtuber 已断开连接");

      session_map.delete(map_key);
      ctx.logger.info(
        "WebSocket closed: {session: %s, url: %s}",
        map_key,
        ws.url
      );
    });

    ws.addEventListener("error", (event) => {
      const [session, _] = session_map.get(map_key);
      session.send("vtuber 连接过程中发生错误，请联系管理员");
      ctx.logger.warn(event);
    });

    ws.addEventListener("message", (event: MessageEvent<string>) => {
      const [session, _] = session_map.get(map_key);
      ctx.logger.debug("WebSocket receive: %s", event.data);
      try {
        const data: VtuberMessage = JSON.parse(event.data);
        switch (data.type) {
          case "full-text": {
            const textMessage = data as TextMessage;
            session.send(textMessage.text);
            break;
          }

          case "audio": {
            const audioMessage = data as AudioMessage;
            full_text += audioMessage.display_text.text;
            const audioPlayStartMessage = new AudioPlayStartMessage(
              audioMessage.display_text,
              true
            );
            ws.send(JSON.stringify(audioPlayStartMessage));
            break;
          }
          case "control": {
            const controlMessage = data as ControlMessage;
            switch (controlMessage.text) {
              case "conversation-chain-start": {
                full_text = "";
                break;
              }
              case "conversation-chain-end": {
                ctx.logger.debug("full_text: %s", full_text);
                if (config.reasoning_model) {
                  let [reasoning_text, send_text] =
                    split_reasoning_text(full_text);

                  if (config.show_reasoning && reasoning_text.length > 0) {
                    session.sendQueued(reasoning_text);
                  }

                  if (config.remove_emoji) {
                    send_text = send_text.replace(emoji_regex, "");
                  }
                  session.sendQueued(send_text);
                } else {
                  session.send(full_text);
                }

                full_text = "";
                break;
              }
            }
          }
          case "backend-synth-complete": {
            if (full_text.length > 0) {
              ws.send(JSON.stringify({ type: "frontend-playback-complete" }));
              break;
            }
          }

          case "new-history-created": {
            const historyCreatedMessage = data as HistoryCreated;
            session.sendQueued(historyCreatedMessage.history_uid);
            break;
          }

          default:
            break;
        }
      } catch (error) {
        ctx.logger.info({ error: error.toString(), msg: event.data });
      }
    });

    return ws;
  }

  ctx.middleware((session, next) => {
    const [event, map_key] = get_event_and_key(session);
    const textMessage = new TextMessage(session.content);

    if (session_map.has(map_key)) {
      const [_, ws, uid] = session_map.get(map_key);
      session_map.set(map_key, [session, ws, uid]);
      try {
        ws.send(JSON.stringify(textMessage));
      } catch (error) {
        ctx.logger.warn({ error: error.toString(), msg: textMessage });
      }
    }

    return next();
  });

  ctx.on("dispose", () => {
    for (const [_, ws] of session_map.values()) {
      ws.close();
    }
  });
}

function get_event_and_key(session: Session): [ParseEvent, string] {
  const event: ParseEvent = JSON.parse(JSON.stringify(session.event));
  const map_key = `${event.platform};${event.channel.id};${event.channel.type}`;
  return [event, map_key];
}

const reasoning_regex = /\(([^)]+)\)/g;
const emoji_regex = /\[([a-zA-Z0-9]+)\]/g;

function split_reasoning_text(text: string): [string, string] {
  let reasoning_text = "";
  let send_text = "";
  const matchs = text.match(reasoning_regex);
  if (matchs) {
    reasoning_text = matchs[0];
    send_text = text.replace(reasoning_text, "");
  } else {
    const temp_text = text.split("\n\n");
    if (temp_text.length === 2) {
      reasoning_text = temp_text[0];
      send_text = temp_text[1];
    }
  }
  return [reasoning_text, send_text];
}
