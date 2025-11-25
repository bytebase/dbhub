--  Sample employee database 
--  See changelog table for details
--  Copyright (C) 2007,2008, MySQL AB
--  
--  Original data created by Fusheng Wang and Carlo Zaniolo
--  http://www.cs.aau.dk/TimeCenter/software.htm
--  http://www.cs.aau.dk/TimeCenter/Data/employeeTemporalDataSet.zip
-- 
--  Current schema by Giuseppe Maxia 
--  Data conversion from XML to relational by Patrick Crews
--  SQLite adaptation by Claude Code
-- 
-- This work is licensed under the 
-- Creative Commons Attribution-Share Alike 3.0 Unported License. 
-- To view a copy of this license, visit 
-- http://creativecommons.org/licenses/by-sa/3.0/ or send a letter to 
-- Creative Commons, 171 Second Street, Suite 300, San Francisco, 
-- California, 94105, USA.
-- 
--  DISCLAIMER
--  To the best of our knowledge, this data is fabricated, and
--  it does not correspond to real people. 
--  Any similarity to existing people is purely coincidental.
-- 

SELECT 'TESTING INSTALLATION' as 'INFO';

DROP TABLE IF EXISTS expected_value;
DROP TABLE IF EXISTS found_value;

CREATE TABLE expected_value (
    table_name TEXT NOT NULL PRIMARY KEY,
    recs INTEGER NOT NULL,
    crc_md5 TEXT NOT NULL
);

CREATE TABLE found_value (
    table_name TEXT NOT NULL PRIMARY KEY,
    recs INTEGER NOT NULL,
    crc_md5 TEXT NOT NULL
);

INSERT INTO expected_value VALUES 
('employee',    1000, '595460127fb609c2b110b1796083e242'),
('department',     9, 'd1af5e170d2d1591d776d5638d71fc5f'),
('dept_manager',  16, '8ff425d5ad6dc56975998d1893b8dca9'),
('dept_emp',    1103, 'e302aa5b56a69b49e40eb0d60674addc'),
('title',       1470, 'ba77dd331ce00f76c1643a7d73cdcee6'),
('salary',      9488, '61f22cfece4d34f5bb94c9f05a3da3ef');

SELECT table_name, recs AS expected_record, crc_md5 AS expected_crc FROM expected_value;

DROP TABLE IF EXISTS tchecksum;
CREATE TABLE tchecksum (chk TEXT);

-- For SQLite, we need to use a different approach for MD5 calculation
-- Insert employee checksums
INSERT INTO found_value
SELECT 'employee', COUNT(*), 
       (SELECT hex(md5(group_concat(emp_no||birth_date||first_name||last_name||gender||hire_date, '#')))
        FROM (SELECT * FROM employee ORDER BY emp_no))
FROM employee;

-- Insert department checksums
INSERT INTO found_value
SELECT 'department', COUNT(*),
       (SELECT hex(md5(group_concat(dept_no||dept_name, '#')))
        FROM (SELECT * FROM department ORDER BY dept_no))
FROM department;

-- Insert dept_manager checksums
INSERT INTO found_value
SELECT 'dept_manager', COUNT(*),
       (SELECT hex(md5(group_concat(dept_no||emp_no||from_date||to_date, '#')))
        FROM (SELECT * FROM dept_manager ORDER BY dept_no, emp_no))
FROM dept_manager;

-- Insert dept_emp checksums
INSERT INTO found_value
SELECT 'dept_emp', COUNT(*),
       (SELECT hex(md5(group_concat(dept_no||emp_no||from_date||to_date, '#')))
        FROM (SELECT * FROM dept_emp ORDER BY dept_no, emp_no))
FROM dept_emp;

-- Insert title checksums
INSERT INTO found_value
SELECT 'title', COUNT(*),
       (SELECT hex(md5(group_concat(emp_no||title||from_date||IFNULL(to_date,''), '#')))
        FROM (SELECT * FROM title ORDER BY emp_no, title, from_date))
FROM title;

-- Insert salary checksums
INSERT INTO found_value
SELECT 'salary', COUNT(*),
       (SELECT hex(md5(group_concat(emp_no||amount||from_date||to_date, '#')))
        FROM (SELECT * FROM salary ORDER BY emp_no, from_date, to_date))
FROM salary;

SELECT table_name, recs as 'found_records', crc_md5 as found_crc FROM found_value;

-- Compare expected vs found
SELECT  
    e.table_name, 
    CASE WHEN e.recs=f.recs THEN 'OK' ELSE 'not ok' END AS records_match, 
    CASE WHEN e.crc_md5=f.crc_md5 THEN 'ok' ELSE 'not ok' END AS crc_match 
FROM 
    expected_value e 
    JOIN found_value f USING (table_name);

-- Check for failures
SELECT 
    'CRC' as summary, 
    CASE WHEN (SELECT COUNT(*) FROM expected_value e JOIN found_value f USING(table_name) WHERE f.crc_md5 != e.crc_md5) = 0 
         THEN 'OK' ELSE 'FAIL' END as 'result'
UNION ALL
SELECT 
    'count', 
    CASE WHEN (SELECT COUNT(*) FROM expected_value e JOIN found_value f USING(table_name) WHERE f.recs != e.recs) = 0 
         THEN 'OK' ELSE 'FAIL' END;