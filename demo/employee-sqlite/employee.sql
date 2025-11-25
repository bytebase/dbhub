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

PRAGMA foreign_keys = ON;

SELECT 'CREATING DATABASE STRUCTURE' as 'INFO';

DROP TABLE IF EXISTS dept_emp;
DROP TABLE IF EXISTS dept_manager;
DROP TABLE IF EXISTS title;
DROP TABLE IF EXISTS salary;
DROP TABLE IF EXISTS employee;
DROP TABLE IF EXISTS department;
DROP VIEW IF EXISTS dept_emp_latest_date;
DROP VIEW IF EXISTS current_dept_emp;

CREATE TABLE employee (
    emp_no      INTEGER         NOT NULL,
    birth_date  DATE            NOT NULL,
    first_name  TEXT            NOT NULL,
    last_name   TEXT            NOT NULL,
    gender      TEXT            NOT NULL CHECK (gender IN ('M','F')),
    hire_date   DATE            NOT NULL,
    PRIMARY KEY (emp_no)
);

CREATE TABLE department (
    dept_no     TEXT            NOT NULL,
    dept_name   TEXT            NOT NULL,
    PRIMARY KEY (dept_no),
    UNIQUE      (dept_name)
);

CREATE TABLE dept_manager (
   emp_no       INTEGER         NOT NULL,
   dept_no      TEXT            NOT NULL,
   from_date    DATE            NOT NULL,
   to_date      DATE            NOT NULL,
   FOREIGN KEY (emp_no)  REFERENCES employee (emp_no)    ON DELETE CASCADE,
   FOREIGN KEY (dept_no) REFERENCES department (dept_no) ON DELETE CASCADE,
   PRIMARY KEY (emp_no,dept_no)
); 

CREATE TABLE dept_emp (
    emp_no      INTEGER         NOT NULL,
    dept_no     TEXT            NOT NULL,
    from_date   DATE            NOT NULL,
    to_date     DATE            NOT NULL,
    FOREIGN KEY (emp_no)  REFERENCES employee (emp_no)   ON DELETE CASCADE,
    FOREIGN KEY (dept_no) REFERENCES department (dept_no) ON DELETE CASCADE,
    PRIMARY KEY (emp_no,dept_no)
);

CREATE TABLE title (
    emp_no      INTEGER         NOT NULL,
    title       TEXT            NOT NULL,
    from_date   DATE            NOT NULL,
    to_date     DATE,
    FOREIGN KEY (emp_no) REFERENCES employee (emp_no) ON DELETE CASCADE,
    PRIMARY KEY (emp_no,title,from_date)
);

CREATE TABLE salary (
    emp_no      INTEGER         NOT NULL,
    amount      INTEGER         NOT NULL,
    from_date   DATE            NOT NULL,
    to_date     DATE            NOT NULL,
    FOREIGN KEY (emp_no) REFERENCES employee (emp_no) ON DELETE CASCADE,
    PRIMARY KEY (emp_no,from_date)
);

CREATE VIEW dept_emp_latest_date AS
    SELECT emp_no, MAX(from_date) AS from_date, MAX(to_date) AS to_date
    FROM dept_emp
    GROUP BY emp_no;

-- shows only the current department for each employee
CREATE VIEW current_dept_emp AS
    SELECT l.emp_no, dept_no, l.from_date, l.to_date
    FROM dept_emp d
        INNER JOIN dept_emp_latest_date l
        ON d.emp_no=l.emp_no AND d.from_date=l.from_date AND l.to_date = d.to_date;

SELECT 'LOADING department' as 'INFO';
.read load_department.sql
SELECT 'LOADING employee' as 'INFO';
.read load_employee.sql
SELECT 'LOADING dept_emp' as 'INFO';
.read load_dept_emp.sql
SELECT 'LOADING dept_manager' as 'INFO';
.read load_dept_manager.sql
SELECT 'LOADING title' as 'INFO';
.read load_title.sql
SELECT 'LOADING salary' as 'INFO';
.read load_salary1.sql