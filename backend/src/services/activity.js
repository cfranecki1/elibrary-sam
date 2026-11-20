const db = require('../db');
function logActivity({ actorId = null, subjectId = null, eventType, entityType = null, entityId = null, summary }) {
  db.get().prepare('INSERT INTO activity_log (actor_user_id, subject_user_id, event_type, entity_type, entity_id, summary, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(actorId, subjectId, eventType, entityType, entityId, summary, new Date().toISOString());
}
module.exports = { logActivity };
