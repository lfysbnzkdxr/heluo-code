export class HeluoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HeluoError'
  }
}

export class ConfigError extends HeluoError {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export class LlmError extends HeluoError {
  constructor(message: string) {
    super(message)
    this.name = 'LlmError'
  }
}

export class ToolError extends HeluoError {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

export class SessionError extends HeluoError {
  constructor(message: string) {
    super(message)
    this.name = 'SessionError'
  }
}
