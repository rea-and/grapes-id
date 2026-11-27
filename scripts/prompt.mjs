// Ask for a secret in the terminal without echoing it (no extra packages).
import readline from 'node:readline'

export function askHidden(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const write = rl._writeToOutput
  let muted = false
  // The question is printed normally; once it is on screen, whatever is typed is swallowed.
  rl._writeToOutput = (s) => { if (!muted) write.call(rl, s) }
  return new Promise((ok) => {
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); ok(answer) })
    muted = true
  })
}
