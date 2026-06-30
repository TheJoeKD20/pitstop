import { createInterface } from "node:readline";
import pc from "picocolors";

/** Abstraction over interactive prompting so the executor can be unit-tested. */
export interface Prompter {
  /**
   * Ask the user to choose one of `choices` (matched case-insensitively by their
   * leading letter or full word). Returns the chosen key.
   */
  choose(question: string, choices: PromptChoice[]): Promise<string>;
}

export interface PromptChoice {
  /** The value returned when chosen. */
  key: string;
  /** Single-letter shortcut shown to the user. */
  hotkey: string;
  /** Human description. */
  label: string;
}

/** Readline-backed prompter for real terminal use. */
export class TerminalPrompter implements Prompter {
  async choose(question: string, choices: PromptChoice[]): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const hint = choices.map((c) => `${pc.bold(c.hotkey)})${c.label}`).join("  ");
    try {
      for (;;) {
        const answer = (
          await new Promise<string>((res) => rl.question(`${question} ${hint} > `, res))
        )
          .trim()
          .toLowerCase();
        const match = choices.find(
          (c) => c.hotkey.toLowerCase() === answer || c.key.toLowerCase() === answer,
        );
        if (match) return match.key;
        process.stdout.write(pc.yellow(`  Please enter one of: ${choices.map((c) => c.hotkey).join(", ")}\n`));
      }
    } finally {
      rl.close();
    }
  }
}

const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;
const color = pc.createColors(supportsColor);

export const ui = {
  info(msg: string): void {
    process.stdout.write(`${msg}\n`);
  },
  dim(msg: string): void {
    process.stdout.write(`${color.dim(msg)}\n`);
  },
  success(msg: string): void {
    process.stdout.write(`${color.green("✓")} ${msg}\n`);
  },
  warn(msg: string): void {
    process.stdout.write(`${color.yellow("!")} ${msg}\n`);
  },
  /** A step banner shown before each step runs. */
  step(index: number, total: number, label: string): void {
    const counter = color.dim(`[${index}/${total}]`);
    process.stdout.write(`\n${counter} ${color.bold(color.cyan(label))}\n`);
  },
  /** The breakpoint banner. */
  breakpoint(label: string): void {
    const bar = color.magenta("━".repeat(48));
    process.stdout.write(
      `\n${bar}\n${color.magenta(color.bold("⏸  BREAKPOINT"))}  before: ${color.bold(label)}\n${bar}\n`,
    );
  },
  /** Print an error in the plain-language house style. */
  error(message: string, hint?: string): void {
    process.stderr.write(`\n${color.red(color.bold("✗ "))}${color.red(message)}\n`);
    if (hint) {
      for (const line of hint.split("\n")) {
        process.stderr.write(`  ${color.dim(line)}\n`);
      }
    }
    process.stderr.write("\n");
  },
  raw: color,
};
