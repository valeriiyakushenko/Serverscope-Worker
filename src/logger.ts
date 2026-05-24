import fs from 'fs'
import path from 'path'

const LOGS_DIR = path.resolve(process.cwd(), 'logs')

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true })
}

function utcDateString(): string {
  return new Date().toISOString().slice(0, 10)
}

function writeToFile(line: string): void {
  const filePath = path.join(LOGS_DIR, `${utcDateString()}.log`)
  fs.appendFileSync(filePath, line + '\n', 'utf8')
}

function formatLine(level: string, message: string): string {
  return `[${new Date().toISOString()}] [${level.padEnd(5)}] ${message}`
}

export const logger = {
  info: (message: string): void => {
    const line = formatLine('INFO', message)
    console.log(line)
    writeToFile(line)
  },
  warn: (message: string): void => {
    const line = formatLine('WARN', message)
    console.warn(line)
    writeToFile(line)
  },
  error: (message: string): void => {
    const line = formatLine('ERROR', message)
    console.error(line)
    writeToFile(line)
  },
}
