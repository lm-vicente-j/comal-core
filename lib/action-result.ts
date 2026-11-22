export type FieldErrors = Record<string, string[]>;

export type FieldErrorsInput = Record<string, string[] | undefined>;

export type ActionSuccess<T = undefined> = ([T] extends [undefined]
    ? { success: true; data?: undefined }
    : { success: true; data: T }) & {
    error?: undefined;
    fieldErrors?: undefined;
};

export type ActionFailure<
    E extends string = string,
    F extends FieldErrors = FieldErrors,
    D = undefined,
> = {
    success: false;
    error: E;
    fieldErrors?: F;
} & ([D] extends [undefined] ? { data?: undefined } : { data?: D });

export type ActionResult<
    T = undefined,
    E extends string = string,
    F extends FieldErrors = FieldErrors,
    D = undefined,
> = ActionSuccess<T> | ActionFailure<E, F, D>;

function normalizeFieldErrors<F extends FieldErrors>(
    raw?: FieldErrorsInput,
): F | undefined {
    if (!raw) return undefined;
    const cleaned: Record<string, string[]> = {};
    for (const [key, messages] of Object.entries(raw)) {
        if (messages && messages.length > 0) {
            cleaned[key] = messages;
        }
    }
    return cleaned as F;
}

export function actionOk(): { success: true; data?: undefined; error?: undefined; fieldErrors?: undefined };
export function actionOk<T>(data: T): { success: true; data: T; error?: undefined; fieldErrors?: undefined };
export function actionOk<T>(data?: T) {
    return data === undefined ? { success: true as const } : { success: true as const, data };
}

export function actionFail<
    E extends string = string,
    F extends FieldErrors = FieldErrors,
>(
    error: E,
    extra?: { fieldErrors?: FieldErrorsInput },
): ActionFailure<E, F, undefined>;
export function actionFail<
    E extends string = string,
    F extends FieldErrors = FieldErrors,
    D = undefined,
>(
    error: E,
    extra: { fieldErrors?: FieldErrorsInput; data: D },
): ActionFailure<E, F, D>;
export function actionFail<
    E extends string = string,
    F extends FieldErrors = FieldErrors,
    D = undefined,
>(
    error: E,
    extra?: { fieldErrors?: FieldErrorsInput; data?: D },
): ActionFailure<E, F, D> {
    const fieldErrors = normalizeFieldErrors<F>(extra?.fieldErrors);
    return {
        success: false as const,
        error,
        ...(fieldErrors !== undefined ? { fieldErrors } : {}),
        ...(extra?.data !== undefined ? { data: extra.data } : {}),
    } as ActionFailure<E, F, D>;
}
