-- SQLite doesn't have information_schema like MySQL
-- This is a simpler version that just shows when the script was run

SELECT 'Database loaded at ' || datetime('now', 'localtime') AS completion_time;