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
