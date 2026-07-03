import readline from "node:readline";

export async function pickSession({ sessions, input = process.stdin, output = process.stdout }) {
  if (sessions.length === 0) return null;
  if (!input.isTTY || !output.isTTY) {
    printSessionChoices({ sessions, output });
    return sessions[0];
  }

  readline.emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  let selected = 0;

  function render() {
    output.write("\x1b[2J\x1b[H");
    output.write("Select a session with Up/Down. Enter to resume, q/Esc to cancel.\n\n");
    for (let index = 0; index < sessions.length; index += 1) {
      const session = sessions[index];
      const marker = index === selected ? ">" : " ";
      output.write(`${marker} ${formatSession(session)}\n`);
    }
  }

  return await new Promise((resolve) => {
    function cleanup(value) {
      input.off("keypress", onKeypress);
      input.setRawMode(wasRaw);
      output.write("\n");
      resolve(value);
    }

    function onKeypress(_, key) {
      if (key.name === "up") {
        selected = selected === 0 ? sessions.length - 1 : selected - 1;
        render();
      } else if (key.name === "down") {
        selected = (selected + 1) % sessions.length;
        render();
      } else if (key.name === "return") {
        cleanup(sessions[selected]);
      } else if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
        cleanup(null);
      }
    }

    input.on("keypress", onKeypress);
    render();
  });
}

export function printSessionChoices({ sessions, output = process.stdout }) {
  for (const session of sessions) {
    output.write(`${formatSession(session)}\n`);
  }
}

function formatSession(session) {
  return `${session.sessionId}  ${session.updatedAt ?? "-"}  ${session.model ?? "-"}  ${session.title ?? "(untitled)"}`;
}
