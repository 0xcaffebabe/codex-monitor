export class ControlError extends Error {
  constructor(
    message: string,
    public uncertain = false,
    public status = 503,
    public code?: 'compacting',
  ) {
    super(message);
  }
}
