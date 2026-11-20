-- Recordings an agent can read (docs/PRIVACY.md, "Recordings"; FounderData Pro's pro/docs/RECORDINGS.md).
-- 0080 and 0081 are taken by mail on the phone and plan questions on other branches.

-- What happened in a recorded visit, as JSON text of at most 2,000 characters: the viewport, each page with its time,
-- deepest scroll, clicks that changed nothing, the names of form fields the visitor changed (never what they typed)
-- and whether a form was sent. The recorder sends it with the chunks it already uploads. NULL until it sent one.
ALTER TABLE replays ADD COLUMN digest TEXT;

-- Why recordings may not arrive: JSON {"at": ms, "reason": "origin|too_large|too_many|expired|blocked", "detail": "..."},
-- the newest refused upload or a recorder script that could not load. Written at most once an hour per site.
ALTER TABLE sites ADD COLUMN record_health TEXT;

-- When Record visits was last turned on (ms), so the settings card can count the visits since then. NULL: never.
ALTER TABLE sites ADD COLUMN record_on_at INTEGER;
