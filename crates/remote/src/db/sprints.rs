use api_types::{Sprint, SprintState};
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum SprintError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

/// Read access to the remote `sprints` mirror (PRD §4.3). Sprints stream to the
/// board UI via the Electric `PROJECT_SPRINTS_SHAPE`; this repository backs that
/// shape's REST fallback. Sprints are created/edited elsewhere (out of #107's
/// selector scope), so only a project listing is exposed here.
pub struct SprintRepository;

impl SprintRepository {
    pub async fn list_by_project(
        pool: &PgPool,
        project_id: Uuid,
    ) -> Result<Vec<Sprint>, SprintError> {
        let records = sqlx::query_as!(
            Sprint,
            r#"
            SELECT
                id          AS "id!: Uuid",
                project_id  AS "project_id!: Uuid",
                name        AS "name!",
                starts_at   AS "starts_at: DateTime<Utc>",
                ends_at     AS "ends_at: DateTime<Utc>",
                state       AS "state!: SprintState",
                created_at  AS "created_at!: DateTime<Utc>",
                updated_at  AS "updated_at!: DateTime<Utc>"
            FROM sprints
            WHERE project_id = $1
            ORDER BY created_at
            "#,
            project_id
        )
        .fetch_all(pool)
        .await?;

        Ok(records)
    }
}
