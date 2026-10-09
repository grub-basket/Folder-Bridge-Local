const PREFIX = '[Folder Bridge]';

/** Console logging with a consistent prefix. Debug output is hidden unless the console shows verbose logs. */
export const logger = {
	debug: (...args: unknown[]): void => console.debug(PREFIX, ...args),
	warn: (...args: unknown[]): void => console.warn(PREFIX, ...args),
	error: (...args: unknown[]): void => console.error(PREFIX, ...args),
};
