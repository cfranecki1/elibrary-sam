const { badRequest } = require('../errors');
// Zod 4 adapter: error.issues -> §9 envelope details.
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const input = source === 'body' ? (req.body ?? {}) : source === 'query' ? req.query : req.params;
    const result = schema.safeParse(input);
    if (!result.success) {
      const details = result.error.issues.map(i => ({ field: i.path.join('.') || '(root)', message: i.message }));
      return next(badRequest('Validation failed', { details }));
    }
    if (source === 'body') req.body = result.data; else if (source === 'query') req.validQuery = result.data; else req.validParams = result.data;
    next();
  };
}
module.exports = { validate };
