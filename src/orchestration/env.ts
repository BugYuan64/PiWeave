/**
 * Loads `.env` from the working directory, if present.
 *
 * `process.loadEnvFile` does not overwrite variables that already exist, so a real
 * environment variable always wins over the file. A missing file is not an error: the
 * variables may come from the shell, and the CLI reports exactly which ones are absent.
 */
export function loadDotEnv(path: string = ".env"): void {
	try {
		process.loadEnvFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}
