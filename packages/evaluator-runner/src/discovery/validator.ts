import { Ajv } from 'ajv';
// ajv-formats ships as `export default formatsPlugin` in its
// .d.ts but the published CJS interop under NodeNext exposes the
// plugin as `{ default: fn }`. Reach through both shapes.
import * as addFormatsModule from 'ajv-formats';

const addFormatsRaw = addFormatsModule as unknown as
  | ((ajv: Ajv) => Ajv)
  | { default: (ajv: Ajv) => Ajv };
const addFormats: (ajv: Ajv) => Ajv =
  typeof addFormatsRaw === 'function' ? addFormatsRaw : addFormatsRaw.default;

/**
 * ajv-backed JSON Schema validator factory. Returns a function with
 * the signature `resolveEvaluator` expects: `(params, schema) => void`,
 * throwing a synchronous error when params fail validation.
 *
 * One Ajv instance is reused across every spec — compile caches by
 * schema identity. Format vocabulary (date-time / uri / email /
 * regex / ...) is registered via ajv-formats so pack authors writing
 * `format: 'uri'` in params_schema get the standard validators.
 *
 * The compile-on-demand cost is amortized because each call passes
 * the same `params_schema` object reference per spec.
 */
export function createParamsValidator(): (
  params: Record<string, unknown>,
  schema: Record<string, unknown>
) => void {
  const ajv = new Ajv({
    allErrors: true,
    strict: false, // accept schemas with non-standard keywords
    useDefaults: false,
  });
  addFormats(ajv);

  return (params, schema) => {
    const validate = ajv.compile(schema);
    const ok = validate(params);
    if (!ok) {
      const firstErr = validate.errors?.[0];
      const fieldPath = firstErr?.instancePath
        ? firstErr.instancePath.replace(/^\//, '').replace(/\//g, '.')
        : '(root)';
      throw new Error(`${fieldPath} ${firstErr?.message ?? 'failed JSON Schema validation'}`);
    }
  };
}
