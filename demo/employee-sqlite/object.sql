-- SQLite implementation of views and functions
-- This is simplified compared to the MySQL version

-- Drop views if they exist
DROP VIEW IF EXISTS v_full_employee;
DROP VIEW IF EXISTS v_full_department;
DROP VIEW IF EXISTS emp_dept_current;

-- Create helper view to get current department for employees
CREATE VIEW emp_dept_current AS
SELECT 
    e.emp_no,
    de.dept_no
FROM 
    employee e
JOIN 
    dept_emp de ON e.emp_no = de.emp_no
JOIN (
    SELECT 
        emp_no, 
        MAX(from_date) AS max_from_date
    FROM 
        dept_emp
    GROUP BY 
        emp_no
) latest ON de.emp_no = latest.emp_no AND de.from_date = latest.max_from_date;

-- View that shows employee with their current department name
CREATE VIEW v_full_employee AS
SELECT
    e.emp_no,
    e.first_name, 
    e.last_name,
    e.birth_date, 
    e.gender,
    e.hire_date,
    d.dept_name AS department
FROM
    employee e
LEFT JOIN
    emp_dept_current edc ON e.emp_no = edc.emp_no
LEFT JOIN
    department d ON edc.dept_no = d.dept_no;

-- View to get current managers for departments
CREATE VIEW current_managers AS
SELECT
    d.dept_no,
    d.dept_name,
    e.first_name || ' ' || e.last_name AS manager
FROM
    department d
LEFT JOIN
    dept_manager dm ON d.dept_no = dm.dept_no
JOIN (
    SELECT
        dept_no,
        MAX(from_date) AS max_from_date
    FROM
        dept_manager
    GROUP BY
        dept_no
) latest ON dm.dept_no = latest.dept_no AND dm.from_date = latest.max_from_date
LEFT JOIN
    employee e ON dm.emp_no = e.emp_no;

-- Create a view showing departments with their managers
CREATE VIEW v_full_department AS
SELECT
    dept_no,
    dept_name,
    manager
FROM
    current_managers;