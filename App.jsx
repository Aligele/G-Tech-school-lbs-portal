import React, { useState, useEffect, useCallback, useRef } from "react";
import { qrMatrix, qrSvgPath } from "./qr.js";
import {
  loadRoster, saveRoster as persistRoster, isShared, isOffline, hasPendingChanges,
  staffLogin, staffLogout, restoreSession, getWho, changeMyPassword,
  staffList, staffUpsert, staffDeactivate, parentLookup,
  requestReset, confirmReset, staffSetEmail, staffSetContact, setMyContact, schoolInfo,
  logoGet, logoSet, shrinkLogo,
  photoSet, photoDelete, photosGet, photosWhich,
  healthCheck, backupsList, backupNow, backupRestore, staffResetPassword,
  geofenceGet, geofenceSet, locationRecent, locationRecord, currentPosition, metresBetween,
  leaveApply, leaveList, leaveDecide, leaveCancel, leaveToday,
  assignmentSave, assignmentDelete, assignmentsForClass, submissionsFor, submissionMark,
  assignmentsForStudent, submissionSend,
  changeOwnPassword, passwordProblem, sessionsList, sessionsRevoke, securityRecent,
  listSchools, lastSchool, ownerSchools, schoolCreate, schoolSetActive, schoolFromUrl, schoolUrl,
  ownerEnterSchool, isVisitingAsOwner, ownerReturnHome,
  unitsAvailable, unitRegister, unitDrop, myRegistrations, myTranscript,
  unitUpsert, unitsManageList, unitGrade, unitRoster,
  workFileAdd, workFileDelete, workFilesList, workFilesForStudent,
  submissionFileAdd, submissionFilesList, downloadWorkFile, readFileAsBase64, storageUsed,
  expenseCategories, expenseAdd, expenseList, expenseSummary, expenseDelete,
  mpesaClaim, mpesaLookup, mpesaRecent, mpesaRelease,
} from "./store.js";

// ---------- helpers ----------
const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso) => {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};
// Admission numbers look like STU/2026/001 — sequential within the year.
// Existing numbers are scanned so removing a student never causes a clash.
const nextAdmissionNo = (students) => {
  const year = new Date().getFullYear();
  const prefix = `STU/${year}/`;
  let max = 0;
  (students || []).forEach((s) => {
    const m = String(s.id || "").match(/^STU\/(\d{4})\/(\d+)$/);
    if (m && m[1] === String(year)) max = Math.max(max, parseInt(m[2], 10));
  });
  return prefix + String(max + 1).padStart(3, "0");
};

// Sequential receipt numbers, e.g. RCP/2026/001
const nextReceiptNo = (roster) => {
  const year = new Date().getFullYear();
  let max = 0;
  (roster.students || []).forEach((s) => (s.payments || []).forEach((p) => {
    const m = String(p.receiptNo || "").match(/^RCP\/(\d{4})\/(\d+)$/);
    if (m && m[1] === String(year)) max = Math.max(max, parseInt(m[2], 10));
  }));
  return `RCP/${year}/` + String(max + 1).padStart(3, "0");
};

const genId = (prefix, list) => {
  const n = (list?.length || 0) + 1;
  return `${prefix}-${String(n).padStart(3, "0")}-${Math.random().toString(36).slice(2, 5)}`;
};
const slugUser = (name) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
const termKey = (t) => (t || "term").trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "") || "term";
const money = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isRateLimit = (e) => /rate limit/i.test(e?.message || "");
const isNotFound = (e) => /not found|does not exist|no such key|no value/i.test(e?.message || "");

// Everything lives in ONE storage document. Separate per-class/per-term keys
// proved unreliable in practice, while this single key has always worked —
// so attendance and marks are kept inside it rather than in their own entries.
const ROSTER_KEY = "roster";

function useCooldown(ms = 1200) {
  const [onCooldown, setOnCooldown] = useState(false);
  const run = useCallback(async (fn) => {
    if (onCooldown) return;
    setOnCooldown(true);
    try {
      await fn();
    } finally {
      setTimeout(() => setOnCooldown(false), ms);
    }
  }, [onCooldown, ms]);
  return [onCooldown, run];
}

const STATUS = {
  present: { label: "Present", ink: "#0E7A3C", mark: "P" },
  absent: { label: "Absent", ink: "#C0261B", mark: "A" },
  late: { label: "Late", ink: "#8A6A00", mark: "L" },
};

const APP_VERSION = "v57 · offline saves retry themselves";

// Keeps the last 400 actions so the school can see who changed what.
const logAction = (roster, actor, action) => {
  const entry = { ts: new Date().toISOString(), actor: actor || "—", action };
  const audit = [entry, ...(roster.audit || [])].slice(0, 400);
  return { ...roster, audit };
};
// The school's identity is stored in Settings so the portal can serve any
// school. These are only fallbacks used before the details load.
const DEFAULT_SCHOOL_NAME = "Banane Shantral Primary School";
const DEFAULT_SCHOOL_LOCATION = "Sabuli, Wajir County";
const DEFAULT_MOTTO = "ROLL · RECORD · REGISTER";

// Shared across the app so every screen and printed document agrees.
let SCHOOL_NAME = DEFAULT_SCHOOL_NAME;
let SCHOOL_LOCATION = DEFAULT_SCHOOL_LOCATION;
let SCHOOL_MOTTO = DEFAULT_MOTTO;
const applySchoolIdentity = (s) => {
  SCHOOL_NAME = s?.schoolName || s?.name || DEFAULT_SCHOOL_NAME;
  SCHOOL_LOCATION = s?.schoolLocation || s?.location || DEFAULT_SCHOOL_LOCATION;
  SCHOOL_MOTTO = s?.schoolMotto || s?.motto || DEFAULT_MOTTO;
};

// The name that arrives with the session takes precedence over anything in the
// roster: a head teacher signing in to their own school should see their own
// school's name on every screen and every printed page, whatever else is set.
const applySessionSchool = (who) => {
  if (who?.schoolName) {
    SCHOOL_NAME = who.schoolName;
    if (who.schoolLocation) SCHOOL_LOCATION = who.schoolLocation;
  }
};
const DEFAULT_ADMIN_PASSWORD = "admin123";
const DEFAULT_TERM = "Term 1";
const DEFAULT_SUBJECTS = ["Math", "English", "Science", "Social", "IRE", "Kiswahili"];
const SCORE_OPTIONS = Array.from({ length: 100 }, (_, i) => i + 1);

// ---- CBC levels: which learning areas belong to which grades ----
// Kenya's rationalised curriculum gives each level its own set. A Grade 2
// class does Environmental Activities; by Grade 4 that has become Science and
// Technology; by Grade 7, Integrated Science. Showing every area to every
// teacher invites marks against the wrong subject, so the lists are filtered.

// The 47 counties. A list beats free text: it stops "Wajir", "wajir" and
// "Wajir county" becoming three different places in a return to the ministry.
const KENYA_COUNTIES = [
  "Baringo","Bomet","Bungoma","Busia","Elgeyo-Marakwet","Embu","Garissa","Homa Bay",
  "Isiolo","Kajiado","Kakamega","Kericho","Kiambu","Kilifi","Kirinyaga","Kisii",
  "Kisumu","Kitui","Kwale","Laikipia","Lamu","Machakos","Makueni","Mandera",
  "Marsabit","Meru","Migori","Mombasa","Murang'a","Nairobi","Nakuru","Nandi",
  "Narok","Nyamira","Nyandarua","Nyeri","Samburu","Siaya","Taita-Taveta",
  "Tana River","Tharaka-Nithi","Trans Nzoia","Turkana","Uasin Gishu","Vihiga",
  "Wajir","West Pokot",
];

const RELATIONSHIPS = ["Parent","Mother","Father","Guardian","Grandparent",
                       "Aunt or uncle","Elder sibling","Other"];

const CBC_LEVELS = {
  lower:  { label: "Lower Primary (Grades 1–3)",  grades: [1, 2, 3] },
  upper:  { label: "Upper Primary (Grades 4–6)",  grades: [4, 5, 6] },
  junior: { label: "Junior School (Grades 7–9)",  grades: [7, 8, 9] },
  senior: { label: "Senior School (Grades 10–12)", grades: [10, 11, 12] },
};

// Learning areas per level. Anything not listed here is treated as
// school-specific and offered at every level.
const CBC_LEVEL_SUBJECTS = {
  lower: [
    "English", "Kiswahili", "Mathematics",
    "Environmental Activities", "Creative Arts and Sports",
    "Religious Education (IRE)",
  ],
  upper: [
    "English", "Kiswahili", "Mathematics",
    "Science and Technology", "Social Studies",
    "Agriculture and Nutrition", "Creative Arts and Sports",
    "Religious Education (IRE)",
  ],
  junior: [
    "English", "Kiswahili", "Mathematics",
    "Integrated Science", "Social Studies", "Pre-Technical Studies",
    "Agriculture and Nutrition", "Creative Arts and Sports",
    "Religious Education (IRE)",
  ],
  // Senior school: the compulsory core every learner takes, plus whatever the
  // school offers from its pathways. Subjects are added per school rather than
  // listed here, because no two senior schools offer the same combination.
  senior: [
    "English", "Kiswahili", "Mathematics", "Community Service Learning",
    "Physical Education",
  ],
};

// The pathway subjects a senior school might offer. A school turns on the ones
// it actually teaches; nothing is assumed.
const SENIOR_PATHWAY_SUBJECTS = {
  "STEM": [
    "Biology", "Chemistry", "Physics", "General Science",
    "Agriculture", "Computer Studies", "Home Science",
    "Aviation Technology", "Building Construction", "Electricity",
    "Metal Work", "Power Mechanics", "Wood Work", "Media Technology",
    "Marine and Fisheries Technology",
  ],
  "Social Sciences": [
    "History and Citizenship", "Geography", "Business Studies",
    "Christian Religious Education", "Islamic Religious Education",
    "Hindu Religious Education", "Literature in English",
    "Fasihi ya Kiswahili", "Arabic", "French", "German", "Mandarin",
    "Kenyan Sign Language", "Indigenous Language",
  ],
  "Arts and Sports Science": [
    "Sports and Recreation", "Music and Dance", "Theatre and Film",
    "Fine Art",
  ],
};

// Works out the level from the class name, e.g. "Grade 4" or "Class 7B".
const levelOfClassName = (name) => {
  const m = String(name || "").match(/(\d+)/);
  if (!m) return null;
  const g = parseInt(m[1], 10);
  return Object.keys(CBC_LEVELS).find((k) => CBC_LEVELS[k].grades.includes(g)) || null;
};

// The learning areas a given class actually studies. Falls back to the whole
// list when the class name carries no grade number, so nothing is ever hidden
// by accident.
const subjectsForClass = (roster, classId) => {
  const all = roster.subjects || [];
  const level = levelOfClassName(classNameOf(roster, classId));
  if (!level) return all;
  const allowed = CBC_LEVEL_SUBJECTS[level];
  const filtered = all.filter((sub) => allowed.includes(sub));
  // keep any subject the school added itself, which no level claims
  const custom = all.filter((sub) => !Object.values(CBC_LEVEL_SUBJECTS).flat().includes(sub));
  return [...filtered, ...custom];
};

// A teacher is rarely tied to one class. Their real workload is whatever the
// timetable says they teach, plus the class they register. This reads both and
// returns, per class, exactly which learning areas they may enter marks for.
const teachingAssignments = (roster, teacherId) => {
  const teacher = roster.teachers.find((t) => t.id === teacherId);
  if (!teacher) return [];

  const byClass = {};       // classId -> Set of subjects
  const add = (classId, subject) => {
    if (!classId || !subject) return;
    if (!byClass[classId]) byClass[classId] = new Set();
    byClass[classId].add(subject);
  };

  // 1. everything the timetable assigns to them, across any class
  Object.entries(roster.timetable || {}).forEach(([classId, days]) => {
    Object.values(days || {}).forEach((periods) => {
      Object.values(periods || {}).forEach((lesson) => {
        if (lesson && lesson.teacherId === teacherId) add(classId, lesson.subject);
      });
    });
  });

  // 2. their own class, with the subjects recorded against them. A class
  //    teacher usually takes most areas without every one being timetabled.
  (teacher.subjects || []).forEach((sub) => add(teacher.classId, sub));

  return roster.classes
    .filter((c) => byClass[c.id]?.size)
    .map((c) => ({
      classId: c.id,
      className: c.name,
      isHomeClass: c.id === teacher.classId,
      // only areas that class actually studies at its level
      subjects: [...byClass[c.id]].filter((sub) => subjectsForClass(roster, c.id).includes(sub)),
    }))
    .filter((a) => a.subjects.length > 0);
};

// A teacher can only be in one room at a time. This looks across every class
// for the same day and period, so a clash is caught when it is created rather
// than discovered on the morning it matters.
const teacherClashAt = (roster, day, periodId, teacherId, exceptClassId) => {
  if (!teacherId) return null;
  for (const [cid, days] of Object.entries(roster.timetable || {})) {
    if (cid === exceptClassId) continue;
    const lesson = days?.[day]?.[periodId];
    if (lesson && lesson.teacherId === teacherId) {
      return { classId: cid, subject: lesson.subject };
    }
  }
  return null;
};

// Every clash currently in the timetable — used to show the administrator
// anything that slipped in before this check existed.
const allTimetableClashes = (roster) => {
  const seen = {};   // day|period|teacher -> [ {classId, subject} ]
  Object.entries(roster.timetable || {}).forEach(([cid, days]) => {
    Object.entries(days || {}).forEach(([day, periods]) => {
      Object.entries(periods || {}).forEach(([pid, lesson]) => {
        if (!lesson?.teacherId) return;
        const k = `${day}|${pid}|${lesson.teacherId}`;
        (seen[k] = seen[k] || []).push({ classId: cid, subject: lesson.subject });
      });
    });
  });
  return Object.entries(seen)
    .filter(([, v]) => v.length > 1)
    .map(([k, v]) => {
      const [day, periodId, teacherId] = k.split("|");
      return { day, periodId, teacherId, where: v };
    });
};

// Pupils registered before the fuller form still have a single "name". This
// builds a display name from whichever parts exist, so old and new records sit
// together without a migration.
const fullName = (p) => {
  if (!p) return "";
  const parts = [p.firstName, p.middleName, p.surname].filter(Boolean).map((x) => String(x).trim());
  return parts.length ? parts.join(" ") : (p.name || "");
};

// The name to file under: surname first, which is how a register is read.
const filingName = (p) => {
  if (!p) return "";
  if (p.surname) return `${p.surname}, ${[p.firstName, p.middleName].filter(Boolean).join(" ")}`.trim();
  return p.name || "";
};

const levelLabelForClass = (roster, classId) => {
  const level = levelOfClassName(classNameOf(roster, classId));
  return level ? CBC_LEVELS[level].label : null;
};

// Staff must sign in at school by this time; later counts as late.
const ARRIVAL_CUTOFF = { hour: 8, minute: 0 };
// Staff may not sign out before this time without a reason for admin to approve.
const DEPARTURE_TIME = { hour: 16, minute: 0 };
const nowHM = () => { const d = new Date(); return { h: d.getHours(), m: d.getMinutes() }; };
const fmtHM = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const isLateNow = () => {
  const { h, m } = nowHM();
  return h > ARRIVAL_CUTOFF.hour || (h === ARRIVAL_CUTOFF.hour && m > ARRIVAL_CUTOFF.minute);
};
// True when it is still before the 16:00 close of day — leaving now is "early".
const isEarlyDeparture = () => {
  const { h, m } = nowHM();
  return h < DEPARTURE_TIME.hour || (h === DEPARTURE_TIME.hour && m < DEPARTURE_TIME.minute);
};

const DISCIPLINE_CATEGORIES = [
  "Lateness", "Absenteeism", "Noise making", "Bullying", "Fighting",
  "Dishonesty", "Damage to property", "Uniform", "Homework not done", "Other",
];
const DISCIPLINE_ACTIONS = [
  "Verbal warning", "Written warning", "Parent to be called",
  "Counselling recommended", "Referred to admin", "Other",
];

// ---- Timetable & duty roster ----
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const DAY_FULL = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday" };
// A school day is lessons punctuated by breaks. Break rows run across every
// day of the week, so they are part of the timetable rather than a gap in it.
const DEFAULT_PERIODS = [
  { id: "p1", label: "1", time: "8:00–8:40", type: "lesson" },
  { id: "p2", label: "2", time: "8:40–9:20", type: "lesson" },
  { id: "p3", label: "3", time: "9:20–10:00", type: "lesson" },
  { id: "b1", label: "Short break", time: "10:00–10:20", type: "break" },
  { id: "p4", label: "4", time: "10:20–11:00", type: "lesson" },
  { id: "p5", label: "5", time: "11:00–11:40", type: "lesson" },
  { id: "p6", label: "6", time: "11:40–12:20", type: "lesson" },
  { id: "l1", label: "Lunch", time: "12:20–14:00", type: "lunch" },
  { id: "p7", label: "7", time: "14:00–14:40", type: "lesson" },
  { id: "p8", label: "8", time: "14:40–15:20", type: "lesson" },
  { id: "b2", label: "Games / Clubs", time: "15:20–16:00", type: "break" },
];

const PERIOD_TYPES = {
  lesson: { label: "Lesson", bg: "#FFFFFF", fg: "#0A2E1A", band: null },
  break:  { label: "Break",  bg: "#FFF6D6", fg: "#8A6A2C", band: "#FFF6D6" },
  lunch:  { label: "Lunch",  bg: "#E3F5E9", fg: "#0B5C2D", band: "#E3F5E9" },
};
const isLessonPeriod = (p) => (p.type || "lesson") === "lesson";

const getTimetable = (roster, classId) => roster.timetable?.[classId] || {};
const setLessonIn = (roster, classId, day, periodId, lesson) => {
  const cls = { ...(roster.timetable?.[classId] || {}) };
  const dayMap = { ...(cls[day] || {}) };
  if (lesson) dayMap[periodId] = lesson; else delete dayMap[periodId];
  cls[day] = dayMap;
  return { ...roster, timetable: { ...roster.timetable, [classId]: cls } };
};

// Monday of the week containing a given date
const mondayOf = (iso) => {
  const d = new Date(iso + "T00:00:00");
  const shift = (d.getDay() + 6) % 7; // Sun=0 -> 6
  d.setDate(d.getDate() - shift);
  return d.toISOString().slice(0, 10);
};
const weekLabel = (iso) => {
  const start = new Date(iso + "T00:00:00");
  const end = new Date(start); end.setDate(end.getDate() + 4);
  const f = (d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${f(start)} – ${f(end)}`;
};


// ---- Assessments: two CATs plus the main exam, combined by weight ----
const ASSESSMENTS = [
  { key: "cat1", label: "CAT 1", short: "CAT 1" },
  { key: "cat2", label: "CAT 2", short: "CAT 2" },
  { key: "exam", label: "Main Exam", short: "EXAM" },
];
const DEFAULT_WEIGHTS = { cat1: 15, cat2: 15, exam: 70 };

// KCSE-style grading used by Kenyan senior schools
// CBC performance levels (Competency Based Curriculum, Kenya).
// Primary schools report levels 1–4 rather than KCSE letter grades.
// Which scheme the screen currently being drawn should use. React renders a
// tree synchronously, so a component sets this once from its own class before
// drawing anything, and every grade shown beneath it agrees. It defaults to
// CBC, so a screen that forgets to set it shows primary grading rather than
// something wrong for both.
let GRADING_SENIOR = false;
const useGradingFor = (roster, classId) => {
  GRADING_SENIOR = isSeniorClass(roster, classId);
  return GRADING_SENIOR;
};
const setGradingSenior = (v) => { GRADING_SENIOR = !!v; };

const activeBand = (score) => (GRADING_SENIOR ? kcseBand(score) : cbcBand(score));
const gradeOf = (score) => activeBand(score)?.code || "—";
const gradeLabel = (score) => activeBand(score)?.label || "—";
const gradeInk = (score) => activeBand(score)?.ink || "#5E6E64";
// A CBC level number, or the KCSE points value, whichever the class uses.
const gradeLevel = (score) => GRADING_SENIOR
  ? (kcseBand(score)?.points ?? null)
  : (cbcBand(score)?.level ?? null);
// What to call it in a heading: "Level 3" or "8 points".
const levelWord = (score) => {
  if (score === null || score === undefined) return "—";
  return GRADING_SENIOR ? `${gradeLevel(score)} pts` : `L${gradeLevel(score)}`;
};

const CBC_BANDS = [
  { min: 76, level: 4, code: "EE", label: "Exceeding Expectation",   ink: "#0B5C2D" },
  { min: 51, level: 3, code: "ME", label: "Meeting Expectation",     ink: "#0E7A3C" },
  { min: 26, level: 2, code: "AE", label: "Approaching Expectation", ink: "#8A6A00" },
  { min: 0,  level: 1, code: "BE", label: "Below Expectation",       ink: "#C0261B" },
];
const cbcBand = (score) => {
  if (score === null || score === undefined) return null;
  return CBC_BANDS.find((b) => score >= b.min) || CBC_BANDS[CBC_BANDS.length - 1];
};

// ---------- KCSE grading, for senior school ----------
// Grades 10 to 12 are senior school and are still reported the Kenyan way: a
// letter, a points value, and a mean grade across subjects. Nothing about CBC
// levels applies there, so the two schemes sit side by side and the class
// decides which is used.
const KCSE_BANDS = [
  { min: 80, code: "A",  points: 12, label: "Excellent",      ink: "#0B5C2D" },
  { min: 75, code: "A-", points: 11, label: "Excellent",      ink: "#0B5C2D" },
  { min: 70, code: "B+", points: 10, label: "Very good",      ink: "#0E7A3C" },
  { min: 65, code: "B",  points:  9, label: "Very good",      ink: "#0E7A3C" },
  { min: 60, code: "B-", points:  8, label: "Good",           ink: "#0E7A3C" },
  { min: 55, code: "C+", points:  7, label: "Good",           ink: "#8A6A00" },
  { min: 50, code: "C",  points:  6, label: "Average",        ink: "#8A6A00" },
  { min: 45, code: "C-", points:  5, label: "Average",        ink: "#8A6A00" },
  { min: 40, code: "D+", points:  4, label: "Below average",  ink: "#C0261B" },
  { min: 35, code: "D",  points:  3, label: "Below average",  ink: "#C0261B" },
  { min: 30, code: "D-", points:  2, label: "Weak",           ink: "#C0261B" },
  { min:  0, code: "E",  points:  1, label: "Very weak",      ink: "#C0261B" },
];
const kcseBand = (score) => {
  if (score === null || score === undefined) return null;
  return KCSE_BANDS.find((b) => score >= b.min) || KCSE_BANDS[KCSE_BANDS.length - 1];
};

// Which scheme a class is marked under.
//
// A class explicitly named "Form" (Form 1, Form 2...) is always KCSE-graded,
// whatever number follows — that name is the old system's own word for
// itself, so it settles the question outright. Everything else is CBE
// (levels 1-4: EE/ME/AE/BE), except Grade 10 and above, which Kenya's
// senior secondary still reports the KCSE way even under CBE's own class
// numbering.
const gradeNumberOf = (className) => {
  const m = String(className || "").match(/(\d+)/);
  return m ? Number(m[1]) : null;
};
const isSeniorClass = (roster, classId) => {
  const c = roster?.classes?.find((x) => x.id === classId);
  const name = String(c?.name || "");
  if (/\bform\b/i.test(name)) return true;
  const n = gradeNumberOf(name);
  return n !== null && n >= 10;
};

// One set of helpers that answer for whichever scheme applies, so no screen
// has to know which kind of school it is being shown.
const bandFor = (score, senior) => (senior ? kcseBand(score) : cbcBand(score));
const gradeOfIn  = (score, senior) => bandFor(score, senior)?.code  || "—";
const gradeInkIn = (score, senior) => bandFor(score, senior)?.ink   || "#5E6E64";
const gradeLabelIn = (score, senior) => bandFor(score, senior)?.label || "—";
const pointsOf = (score) => kcseBand(score)?.points ?? null;

// The mean grade: total points over subjects, rounded the way KCSE rounds.
const meanGrade = (scores) => {
  const pts = (scores || []).map(pointsOf).filter((p) => p !== null);
  if (!pts.length) return null;
  const total = pts.reduce((a, b) => a + b, 0);
  const mean = total / pts.length;
  // find the letter whose points value the mean rounds to
  const rounded = Math.round(mean);
  const band = KCSE_BANDS.find((b) => b.points === Math.max(1, Math.min(12, rounded)));
  return { total, mean: Math.round(mean * 100) / 100, code: band?.code || "E",
           ink: band?.ink || "#C0261B", subjects: pts.length };
};


// Short code shown in tables, e.g. "ME"; full wording used on report cards.
// Older records stored a single number; treat that as the main exam mark.
const normEntry = (e) => (typeof e === "number" ? { exam: e } : (e || {}));

// Weighted final mark for one subject, scaled to whatever components exist yet.
const subjectFinal = (entry, weights) => {
  const e = normEntry(entry);
  let sum = 0, wsum = 0;
  for (const a of ASSESSMENTS) {
    const v = e[a.key];
    if (typeof v === "number") { sum += v * (weights[a.key] || 0); wsum += (weights[a.key] || 0); }
  }
  return wsum ? Math.round(sum / wsum) : null;
};

const studentSummary = (grid, studentId, subjects, weights) => {
  const per = {};
  let total = 0, count = 0;
  subjects.forEach((sub) => {
    const f = subjectFinal(grid?.[studentId]?.[sub], weights);
    if (f !== null) { per[sub] = f; total += f; count++; }
  });
  return { per, total, count, average: count ? Math.round(total / count) : null };
};

// Ranks a class, sharing a position on ties (1,2,2,4 …).
const classPositions = (grid, students, subjects, weights) => {
  const rows = students
    .map((s) => ({ student: s, ...studentSummary(grid, s.id, subjects, weights) }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.average - a.average);
  let pos = 0, prev = null, seen = 0;
  rows.forEach((r) => { seen++; if (r.average !== prev) { pos = seen; prev = r.average; } r.position = pos; });
  return rows;
};
const positionOf = (rows, studentId) => {
  const r = rows.find((x) => x.student.id === studentId);
  return r ? { position: r.position, outOf: rows.length, average: r.average, total: r.total } : null;
};


const EMPTY_ROSTER = {
  classes: [],
  teachers: [],
  students: [],
  subjects: DEFAULT_SUBJECTS,
  attendance: {},      // { [classId]: { [date]: { [studentId]: status } } }
  staffAttendance: {}, // { [date]: { [teacherId]: status } }
  marks: {},           // { [classId]: { [termKey]: { approved, grid: { [studentId]: { [subject]: {cat1,cat2,exam} } } } } }
  timetable: {},       // { [classId]: { [day]: { [periodId]: { subject, teacherId } } } }
  duty: [],            // [ { id, weekStart, teacherId, note } ]
  discipline: [],      // [ { id, ts, studentId, classId, byTeacher, category, detail, action, status, adminNote } ]
  checkins: {},        // { [date]: { [teacherId]: { time, status, note, approved } } }
  examTimetable: {},   // { [level]: { title, papers: [ { id, date, start, end, subject, invigilator, note } ] } }
  memos: [],           // [ { id, ts, by, title, body, priority, expires, readBy: [teacherId] } ]
  audit: [],           // [ { ts, actor, action } ] — who changed what
  archives: [],        // [ { year, savedAt, snapshot } ] — closed school years
  settings: { currency: "KSh", passMark: 51, weights: DEFAULT_WEIGHTS, periods: DEFAULT_PERIODS,
              schoolName: DEFAULT_SCHOOL_NAME, schoolLocation: DEFAULT_SCHOOL_LOCATION, schoolMotto: DEFAULT_MOTTO },
};

const FONT = {
  display: "'Source Serif 4', Georgia, serif",
  body: "'Inter', system-ui, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
};

export default function SchoolRegister() {
  const [loading, setLoading] = useState(true);
  const [roster, setRoster] = useState(EMPTY_ROSTER);
  const [role, setRole] = useState(null);          // "admin" | "teacher" | "family"
  const [who, setWho] = useState(null);
  const [mustChange, setMustChange] = useState(false);            // signed-in staff { role, name, teacherId }
  const [parentData, setParentData] = useState(null); // the one child a parent may see
  const [activeTeacherId, setActiveTeacherId] = useState(null);
  const [activeStudentId, setActiveStudentId] = useState(null);
  const [toast, setToast] = useState("");

  // Restore a previous staff session, then load the school if signed in.
  useEffect(() => {
    (async () => {
      let session = null;
      try { session = await restoreSession(); } catch (e) { session = getWho(); }
      if (session) {
        setWho(session);
        applySessionSchool(session);
        if (session.schoolCode) {
          logoGet(session.schoolCode).then((d) => {
            applySchoolLogo(d);
            applyInstallIdentity(session.schoolCode, session.schoolName || SCHOOL_NAME, d);
          }).catch(() => {});
        }
        setRole(session.role);
        if (session.mustChange) setMustChange(true);
        if (session.role === "teacher") setActiveTeacherId(session.teacherId);
      } else {
        setLoading(false);
        return;                       // show the login screen
      }
      try {
        const p = await loadRoster();
        if (p) {
          const loaded = {
            ...EMPTY_ROSTER,
            ...p,
            subjects: p.subjects?.length ? p.subjects : DEFAULT_SUBJECTS,
            attendance: p.attendance || {},
            staffAttendance: p.staffAttendance || {},
            marks: p.marks || {},
            timetable: p.timetable || {},
            duty: p.duty || [],
            discipline: p.discipline || [],
            checkins: p.checkins || {},
            examTimetable: p.examTimetable || {},
            memos: p.memos || [],
            audit: p.audit || [],
            archives: p.archives || [],
            settings: {
              ...EMPTY_ROSTER.settings, ...(p.settings || {}),
              weights: { ...DEFAULT_WEIGHTS, ...(p.settings?.weights || {}) },
              periods: p.settings?.periods?.length ? p.settings.periods : DEFAULT_PERIODS,
            },
          };
          applySchoolIdentity(loaded.settings);
          rosterRef.current = loaded;
          setRoster(loaded);
        }
      } catch (e) { /* start from defaults if the first load fails */ }
      setLoading(false);
    })();
  }, []);

  const flashToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2600);
  };

  // ---- Batched background saving --------------------------------------
  // Every change lands in memory instantly and the screen updates straight
  // away. Writes are then coalesced and sent in the background, retrying on
  // their own if the storage service is misbehaving. Nothing the user does
  // is ever blocked by, or lost to, a failed network write.
  const rosterRef = useRef(EMPTY_ROSTER);
  const savingRef = useRef(false);
  const debounceRef = useRef(null);
  const retryRef = useRef(null);
  const [syncState, setSyncState] = useState("saved"); // saved | pending | saving | error

  const flush = useCallback(async () => {
    if (savingRef.current) return;
    clearTimeout(retryRef.current);
    const snapshot = rosterRef.current;
    savingRef.current = true;
    setSyncState("saving");
    try {
      const merged = await persistRoster(snapshot);
      if (merged) { rosterRef.current = merged; setRoster(merged); } // another device had saved; keep both sets of changes
      savingRef.current = false;
      if (rosterRef.current === snapshot) {
        setSyncState("saved");
      } else {
        setSyncState("pending");
        debounceRef.current = setTimeout(flush, 900); // more arrived while saving
      }
    } catch (e) {
      savingRef.current = false;
      setSyncState("error");
      retryRef.current = setTimeout(flush, 7000); // keep trying quietly
    }
  }, []);

  const scheduleSave = useCallback(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(flush, 1200);
  }, [flush]);

  // Callers get an instant, always-successful update. Persistence happens
  // behind the scenes; the sync badge is what reports its real state.
  const saveRoster = useCallback((next, successMsg) => {
    rosterRef.current = next;
    setRoster(next);
    setSyncState("pending");
    scheduleSave();
    if (successMsg) flashToast(successMsg);
    return true;
  }, [scheduleSave]);

  // Offline awareness: report it honestly, and push pending work the moment
  // the connection comes back rather than waiting for the next retry tick.
  const [offline, setOffline] = useState(isOffline());
  useEffect(() => {
    const goOnline = () => { setOffline(false); flush(); };
    const goOffline = () => setOffline(true);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => { window.removeEventListener("online", goOnline); window.removeEventListener("offline", goOffline); };
  }, [flush]);

  useEffect(() => () => { clearTimeout(debounceRef.current); clearTimeout(retryRef.current); }, []);

  if (loading) {
    return <Shell><div style={{ padding: 40, color: "#0A2E1A", fontFamily: FONT.body }}>Opening the register…</div></Shell>;
  }

  return (
    <Shell>
      {toast && <Toast msg={toast} />}
      <SyncBadge state={syncState} offline={offline} onRetry={flush} />
      {!role && (
        <RoleGate
          onStaffSignedIn={async (session) => {
            applySessionSchool(session);
            if (session.schoolCode) {
              logoGet(session.schoolCode).then((d) => {
                applySchoolLogo(d);
                applyInstallIdentity(session.schoolCode, session.schoolName || SCHOOL_NAME, d);
              }).catch(() => {});
            }
            if (session.mustChange) setMustChange(true);
            setWho(session);
            setRole(session.role);
            if (session.role === "teacher") setActiveTeacherId(session.teacherId);
            const p = await loadRoster();
            if (p) {
              const loaded = {
                ...EMPTY_ROSTER, ...p,
                subjects: p.subjects?.length ? p.subjects : DEFAULT_SUBJECTS,
                attendance: p.attendance || {}, staffAttendance: p.staffAttendance || {},
                marks: p.marks || {}, timetable: p.timetable || {}, duty: p.duty || [],
                audit: p.audit || [], archives: p.archives || [],
                settings: {
                  ...EMPTY_ROSTER.settings, ...(p.settings || {}),
                  weights: { ...DEFAULT_WEIGHTS, ...(p.settings?.weights || {}) },
                  periods: p.settings?.periods?.length ? p.settings.periods : DEFAULT_PERIODS,
                },
              };
              rosterRef.current = loaded;
              setRoster(loaded);
            }
          }}
          onParentSignedIn={(payload) => { setParentData(payload); setRole("family"); }}
        />
      )}
      {/* A temporary password must be replaced before anything else — otherwise
          someone else still knows how to sign in as this person. */}
      {role && role !== "family" && mustChange && (
        <div>
          <PortalHeader title={SCHOOL_NAME.toUpperCase()} section="Choose your own password"
            onMenu={() => {}} onExit={async () => { await staffLogout(); setRole(null); setWho(null); setMustChange(false); }} />
          <div style={{ maxWidth: 620, margin: "0 auto", padding: "18px 14px 60px" }}>
            <div className="paper-panel" style={{ ...paperPanel(), padding: 22 }}>
              <ChangeMyPassword who={who} forced onDone={() => setMustChange(false)} />
            </div>
          </div>
        </div>
      )}

      {role === "admin" && !mustChange && (
        <AdminView roster={roster} saveRoster={saveRoster} who={who} syncState={syncState} onForceSave={flush}
          onExit={async () => { await staffLogout(); setRole(null); setWho(null); setRoster(EMPTY_ROSTER); }} />
      )}
      {role === "teacher" && !mustChange && (
        <TeacherView roster={roster} saveRoster={saveRoster} teacherId={activeTeacherId} who={who}
          onExit={async () => { await staffLogout(); setRole(null); setWho(null); setActiveTeacherId(null); setRoster(EMPTY_ROSTER); }} />
      )}
      {role === "finance" && !mustChange && (
        <FinanceView roster={roster} saveRoster={saveRoster} who={who} syncState={syncState} onForceSave={flush}
          onExit={async () => { await staffLogout(); setRole(null); setWho(null); setRoster(EMPTY_ROSTER); }} />
      )}
      {role === "student" && !mustChange && (
        <StudentView who={who}
          onExit={async () => { await staffLogout(); setRole(null); setWho(null); setRoster(EMPTY_ROSTER); }} />
      )}
      {role === "family" && (
        <ParentView payload={parentData} onExit={() => { setParentData(null); setRole(null); }} />
      )}
    </Shell>
  );
}

function SyncBadge({ state, offline, onRetry }) {
  const map = {
    saved:   { text: "✓ All changes saved",   bg: "#24402F", fg: "#7BD79B", border: "#3A6B4C" },
    pending: { text: "• Saving…",             bg: "#24402F", fg: "#B8C4B9", border: "#3A6B4C" },
    saving:  { text: "• Saving…",             bg: "#24402F", fg: "#B8C4B9", border: "#3A6B4C" },
    error:   { text: "⚠ Not saved yet — retrying", bg: "#4A1410", fg: "#F0A99B", border: "#8C1C14" },
  };
  // Offline is not a fault — work is held on the device and syncs later.
  const offlineSaved = { text: "⛅ Offline — saved on this phone", bg: "#0A2E1A", fg: "#FFD84D", border: "#7A5C00" };
  const s = offline ? offlineSaved : (map[state] || map.saved);
  return (
    <div className="no-print" style={{
      position: "fixed", bottom: 12, left: "50%", transform: "translateX(-50%)", zIndex: 90,
      display: "flex", alignItems: "center", gap: 10,
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
      borderRadius: 20, padding: "6px 14px", fontFamily: FONT.mono, fontSize: 11.5,
      boxShadow: "0 3px 12px rgba(0,0,0,0.3)", maxWidth: "92vw",
    }}>
      <span>{s.text}</span>
      {state === "error" && !offline && (
        <button onClick={onRetry} style={{ background: "#FFC400", color: "#0A2E1A", border: "none", borderRadius: 12, padding: "3px 10px", fontFamily: FONT.mono, fontSize: 11, fontWeight: 700 }}>Retry now</button>
      )}
    </div>
  );
}

// ================= SHELL =================
function Shell({ children }) {
  return (
    <div style={{ minHeight: "100vh", background: "#F3F5F4" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        ::selection { background: #FFC400; color: #F3F5F4; }
        button { font-family: inherit; cursor: pointer; }
        input, select { font-family: inherit; }
        button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #FFC400; outline-offset: 2px; }

        /* ================= YELLOW · GREEN · BLACK · WHITE =================
           The rule that keeps this combination sharp rather than shouty:
           yellow is never a text colour on white, because it has no contrast
           there. Yellow sits ON black, or becomes the background with black
           written on it. Green carries action, black carries structure, white
           carries the reading. */

        /* Nothing should fall back to the browser's black. Anything without an
           explicit colour inherits the darkest green instead. */
        body, input, select, textarea, button { color: #0A2E1A; }

        :root {
          --ground:     #F3F5F4;
          --ink:        #0A2E1A;
          --ink:        #0A2E1A;
          --green:      #0E7A3C;
          --green-deep: #0B5C2D;
          --yellow:     #FFC400;
          --yellow-ink: #8A6A00;
          --paper:      #F4F8F5;
          --line:       #DCE6E0;
        }

        /* the focus ring is yellow — visible on black bars and white panels alike */
        :focus-visible {
          outline: 3px solid var(--yellow) !important;
          outline-offset: 2px; border-radius: 3px;
        }

        /* a pressed button gives way, and a yellow one darkens rather than
           brightening, because yellow cannot get lighter and stay readable */
        button:not(:disabled):active { transform: scale(.97); }
        button:not(:disabled):hover  { filter: brightness(1.05); }

        /* selection in the school's own colours */
        ::selection { background: var(--yellow); color: var(--ground); }

        /* a sliver of yellow under every panel heading — the signature */
        .rule-y { position: relative; }
        .rule-y::after {
          content: ""; position: absolute; left: 0; bottom: -6px;
          width: 34px; height: 3px; background: var(--yellow); border-radius: 2px;
        }

        /* scrollbars, on the browsers that allow it */
        * { scrollbar-color: #AFC2B6 transparent; scrollbar-width: thin; }
        *::-webkit-scrollbar { width: 9px; height: 9px; }
        *::-webkit-scrollbar-thumb { background: #AFC2B6; border-radius: 5px; }
        *::-webkit-scrollbar-thumb:hover { background: var(--green); }

        /* inputs settle into green when they hold something valid */
        input:focus, select:focus, textarea:focus {
          border-color: var(--green) !important;
          box-shadow: 0 0 0 3px rgba(255,196,0,.30) !important;
        }

        /* a bar of hazard tape for anything that needs real attention */
        .tape {
          background: repeating-linear-gradient(45deg,
            var(--yellow) 0 12px, #0A2E1A 12px 24px);
          height: 4px; border-radius: 2px;
        }

        @keyframes yPulse {
          0%,100% { box-shadow: 0 0 0 0 rgba(255,196,0,.55) }
          50%     { box-shadow: 0 0 0 7px rgba(255,196,0,0) }
        }
        .alert-dot { animation: yPulse 2.2s ease-out infinite; }

        /* the two doors on the way in: a green edge that arrives under the finger */
        .role-card::before {
          content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px;
          background: #0E7A3C; transform: scaleY(0); transform-origin: center;
          transition: transform .22s cubic-bezier(.2,.7,.3,1);
        }
        .role-card:hover::before, .role-card:focus-visible::before { transform: scaleY(1); }
        .role-card:hover { border-color: #0E7A3C !important; }

        /* the version marker should be readable, not a whisper */
        .version-mark { color: #6C7F72 !important; }

        /* --- interaction: feedback the eye reads faster than text --- */
        button, [role="button"] { transition: transform .11s cubic-bezier(.2,.7,.3,1), filter .15s ease, box-shadow .15s ease; }
        button:not(:disabled):active { transform: scale(.975); }
        button:not(:disabled):hover { filter: brightness(1.06); }
        .lift { transition: transform .16s cubic-bezier(.2,.7,.3,1), box-shadow .16s ease; }
        .lift:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0,0,0,.14); }
        .lift:active { transform: translateY(0); }
        input, select, textarea { transition: border-color .14s ease, box-shadow .14s ease; }
        input:focus, select:focus, textarea:focus { box-shadow: 0 0 0 3px rgba(255,196,0,.30); }
        @keyframes pulseIn { 0% { transform: scale(.94); opacity:.5 } 60% { transform: scale(1.02) } 100% { transform: scale(1); opacity:1 } }
        .pulse { animation: pulseIn .34s cubic-bezier(.2,.7,.3,1); }
        @keyframes shimmer { 0% { background-position:-420px 0 } 100% { background-position:420px 0 } }
        .skeleton { background: linear-gradient(90deg, rgba(10,46,26,.05) 25%, rgba(10,46,26,.11) 37%, rgba(10,46,26,.05) 63%);
                    background-size: 900px 100%; animation: shimmer 1.3s linear infinite; border-radius: 3px; }
        @keyframes slideUp { from { opacity:0; transform: translateY(9px) } to { opacity:1; transform:none } }
        .enter { animation: slideUp .3s cubic-bezier(.2,.7,.3,1) both; }
        @keyframes spin { to { transform: rotate(360deg) } }
        .spin { animation: spin .9s linear infinite; }
        .ring { transform: rotate(-90deg); }
        .ring circle { transition: stroke-dashoffset .6s cubic-bezier(.2,.7,.3,1); }

        /* ---- laptops and desktops ----
           The portal was drawn for a phone in a classroom. On a wide screen the
           same column stranded in the middle wastes most of the glass, so from
           900px the panels widen, forms lay out in columns, and lists become
           grids. Nothing is hidden or added — the same screens, better used. */
        @media (min-width: 900px) {
          body { font-size: 15.5px; }
          .paper-panel { padding: 30px 34px !important; }

          /* registration and settings forms breathe into columns */
          .form-row { grid-template-columns: repeat(3, 1fr) !important; }

          /* card grids get more across rather than taller */
          .grid-cards { grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)) !important; }

          /* long lists of pupils, vouchers and the like read in two columns */
          .list-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: start; }

          /* printed documents show at a comfortable reading width */
          .print-doc { max-width: 900px !important; }
        }

        @media (min-width: 1300px) {
          .list-3col { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; align-items: start; }
        }

        /* a mouse gets hover affordances a finger does not need */
        @media (hover: hover) and (pointer: fine) {
          .lift:hover { transform: translateY(-2px); }
          button { cursor: pointer; }
        }

        @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
        .chalk-fade { animation: chalkIn 0.35s ease both; }
        @keyframes chalkIn { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: translateY(0);} }
        .rise { animation: rise 0.5s cubic-bezier(.2,.7,.3,1) both; }
        @keyframes rise { from { opacity: 0; transform: translateY(14px);} to { opacity: 1; transform: translateY(0);} }
        .gate-bg {
          position: fixed; inset: 0; pointer-events: none;
          background:
            radial-gradient(70% 45% at 50% 0%, rgba(14,122,60,0.05), transparent 70%),
            linear-gradient(180deg, #FFFFFF 0%, #F6F8F7 100%);
        }
        .role-card { transition: transform .18s ease, border-color .18s ease, background .18s ease; }
        .role-card:active { transform: scale(0.985); }
        @media (hover:hover) { .role-card:hover { border-color: #FFC400; background: #2A4636; } }
        .rule { height:1px; flex:1; background:linear-gradient(90deg,transparent,#E1E7E3,transparent); }
        @media print {
          .no-print { display: none !important; }
          html, body { background: #fff !important; }
          .print-doc { box-shadow: none !important; border: none !important; margin: 0 !important; max-width: none !important; padding: 0 !important; }
          .report-page { page-break-after: always; }
          .report-page:last-child { page-break-after: auto; }
        }
      `}</style>
      {isVisitingAsOwner() && (
        <div className="no-print" style={{ background: "#FFC400", color: "#0A2E1A", padding: "9px 16px",
              display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8,
              fontFamily: FONT.mono, fontSize: 12, fontWeight: 700 }}>
          <span>VISITING AS OWNER — everything you do here is theirs, not a copy</span>
          <button onClick={() => { if (ownerReturnHome()) window.location.reload(); }}
            style={{ background: "#0A2E1A", color: "#FFC400", border: "none", borderRadius: 5,
              padding: "5px 12px", fontFamily: FONT.mono, fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
            ← Exit to my Schools
          </button>
        </div>
      )}
      {children}
    </div>
  );
}

function Toast({ msg }) {
  return (
    <div className="chalk-fade" style={{
      position: "fixed", top: 18, left: "50%", transform: "translateX(-50%)",
      background: "#FFC400", color: "#0A2E1A", padding: "8px 18px", borderRadius: 3,
      fontFamily: FONT.body, fontWeight: 600, fontSize: 13, zIndex: 100,
      boxShadow: "0 4px 14px rgba(0,0,0,0.25)", maxWidth: "84vw", textAlign: "center",
    }}>{msg}</div>
  );
}

function Stamp({ status, size = 30 }) {
  const s = STATUS[status];
  if (!s) return <div style={{ width: size, height: size, borderRadius: "50%", border: "1.5px dashed #B9C7BF" }} />;
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", border: `2px solid ${s.ink}`,
      display: "flex", alignItems: "center", justifyContent: "center",
      color: s.ink, fontFamily: FONT.mono, fontWeight: 700, fontSize: size * 0.4,
      transform: "rotate(-6deg)", opacity: 0.9,
    }}>{s.mark}</div>
  );
}

// The school's own crest, once one has been uploaded. Held in a module
// variable rather than passed down: the seal appears on a dozen screens and
// every printed document, and threading a prop through all of them would be
// worse than this. It is set once at sign-in and never changes while the
// portal is open.
let SCHOOL_LOGO = "";
const applySchoolLogo = (dataUrl) => { SCHOOL_LOGO = dataUrl || ""; };

function Seal({ size = 56, ink = "#FFC400" }) {
  // A school that has uploaded its own crest sees that everywhere the drawn
  // one appeared — on screen and on every printed page.
  if (SCHOOL_LOGO) {
    return (
      <img src={SCHOOL_LOGO} alt="" width={size} height={size}
        style={{ width: size, height: size, objectFit: "contain", display: "block" }} />
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="47" fill="none" stroke={ink} strokeWidth="2.5" />
      <circle cx="50" cy="50" r="40" fill="none" stroke={ink} strokeWidth="1" opacity="0.6" />
      <path d="M50 22 L62 30 V50 C62 62 56 70 50 74 C44 70 38 62 38 50 V30 Z" fill="none" stroke={ink} strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M50 34 V60 M42 44 H58" stroke={ink} strokeWidth="2" />
      <path d="M18 50 C24 38 30 32 36 30" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
      <path d="M82 50 C76 38 70 32 64 30" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ---------- shared styles ----------
const inputStyle = () => ({ width: "100%", padding: "10px 12px", borderRadius: 3, border: "1.5px solid #C6D2CA", background: "#FFFFFF", color: "#0A2E1A", fontFamily: FONT.body, fontSize: 14, marginBottom: 4 });
const backBtnStyle = () => ({ background: "none", border: "none", color: "#0B5C2D", fontFamily: FONT.mono, fontSize: 12, padding: 0, textDecoration: "underline" });
const paperPanel = () => ({
  background: "#FFFFFF", borderRadius: 8, border: "1px solid #DCE6E0",
  boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
});
const darkInput = () => ({
  padding: "10px 12px", borderRadius: 4, border: "1.5px solid #C6D2CA",
  background: "#FFFFFF", color: "#0A2E1A", fontSize: 13.5,
});
// The main action is green — it reads as "go" without needing a label to say
// so. Black is kept for structure, not for buttons that do things.
const primaryBtn = () => ({
  background: "#0E7A3C", color: "#FFFFFF", border: "none", borderRadius: 4,
  padding: "10px 17px", fontFamily: FONT.body, fontSize: 13.5, fontWeight: 700,
  letterSpacing: 0.2, boxShadow: "0 1px 0 rgba(0,0,0,.18)",
});
// The one thing on a screen that matters most: black on yellow, which the eye
// finds before it finds anything else.
const alertBtn = () => ({
  background: "#FFC400", color: "#0A2E1A", border: "none", borderRadius: 4,
  padding: "10px 17px", fontFamily: FONT.body, fontSize: 13.5, fontWeight: 800,
  letterSpacing: 0.2, boxShadow: "0 1px 0 rgba(0,0,0,.22)",
});
const classNameOf = (roster, id) => roster.classes.find((c) => c.id === id)?.name || "Unassigned";

function SectionTitle({ children }) {
  // A sliver of yellow under every heading — the one repeated mark that ties
  // the screens together without colouring anything that has to be read.
  return (
    <div className="rule-y" style={{ fontFamily: FONT.display, fontSize: 19, fontWeight: 700,
          color: "#0A2E1A", marginBottom: 18, letterSpacing: "-0.01em", display: "inline-block" }}>
      {children}
    </div>
  );
}

// ---------- form furniture ----------
// A card per section, a label above every field, and the hint beneath rather
// than inside the box — a placeholder disappears the moment someone types,
// which is exactly when they still need it.
function FormCard({ title, children }) {
  return (
    <div style={{ background: "#FFFFFF", border: "1px solid #DCE6E0", borderRadius: 8,
          padding: "16px 17px" }}>
      <div style={{ fontFamily: FONT.display, fontSize: 15.5, fontWeight: 700,
            color: "#0A2E1A", marginBottom: 13 }}>{title}</div>
      <div style={{ display: "grid", gap: 13 }}>{children}</div>
    </div>
  );
}

function FormRow({ children }) {
  return (
    <div className="form-row" style={{ display: "grid", gap: 12,
          gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))" }}>
      {children}
    </div>
  );
}

function Field({ label, hint, required, children }) {
  return (
    <label style={{ display: "block" }}>
      <div style={{ fontFamily: FONT.body, fontSize: 12.5, fontWeight: 600,
            color: "#0A2E1A", marginBottom: 5 }}>
        {label}{required && <span style={{ color: "#C0261B" }}> *</span>}
      </div>
      {children}
      {hint && (
        <div style={{ fontFamily: FONT.body, fontSize: 11, color: "#5E6E64",
              marginTop: 4, lineHeight: 1.45 }}>{hint}</div>
      )}
    </label>
  );
}

function StatCard({ label, value, tone }) {
  return (
    <div className="lift" style={{
      border: "1px solid #DCE6E0", borderRadius: 6, padding: "13px 15px",
      background: "#FFFFFF", borderTop: `3px solid ${tone || "#0A2E1A"}`,
    }}>
      <div style={{ fontFamily: FONT.mono, fontSize: 9.5, color: "#5E6E64",
            letterSpacing: 1.3, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: FONT.display, fontSize: 25, fontWeight: 800,
            color: tone || "#0A2E1A", marginTop: 3, lineHeight: 1 }}>{value}</div>
    </div>
  );
}
function topBar(title, onExit) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 14px", maxWidth: "min(1240px, 100%)", margin: "0 auto", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Seal size={38} />
        <div>
          <div style={{ fontFamily: FONT.mono, color: "#5E6E64", fontSize: 10, letterSpacing: 1.4 }}>{SCHOOL_NAME.toUpperCase()}</div>
          <div style={{ fontFamily: FONT.mono, color: "#5E6E64", fontSize: 9.5, letterSpacing: 1 }}>{SCHOOL_LOCATION}</div>
          <div style={{ fontFamily: FONT.display, color: "#0A2E1A", fontSize: 19, fontWeight: 700 }}>{title}</div>
        </div>
      </div>
      <button onClick={onExit} style={{ background: "#FFFFFF", border: "1px solid #C6D2CA", color: "#0A2E1A", borderRadius: 4, padding: "7px 14px", fontFamily: FONT.body, fontSize: 12, whiteSpace: "nowrap" }}>Sign out</button>
    </div>
  );
}
function TabBar({ tabs, active, onChange }) {
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
      {tabs.map((t) => (
        <button key={t} onClick={() => onChange(t)} style={{
          background: active === t ? "#FFC400" : "transparent", color: active === t ? "#F3F5F4" : "#FFFFFF",
          border: "1px solid " + (active === t ? "#FFC400" : "#E1E7E3"), borderRadius: 3, padding: "6px 13px",
          fontFamily: FONT.body, fontSize: 12.5, fontWeight: 600, textTransform: "capitalize",
        }}>{t}</button>
      ))}
    </div>
  );
}
function RowList({ items, render, onRemove }) {
  if (items.length === 0) return <div style={{ fontFamily: FONT.body, fontSize: 13, color: "#5E6E64" }}>Nothing here yet.</div>;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {items.map((it) => (
        <div key={it.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 12px", background: "#F4F8F5", border: "1px solid #DCE6E0", borderRadius: 3 }}>
          <span style={{ fontFamily: FONT.body, fontSize: 13.5, color: "#0A2E1A" }}>{render(it)}</span>
          {onRemove && <button onClick={() => onRemove(it.id)} style={{ background: "none", border: "none", color: "#C0261B", fontFamily: FONT.mono, fontSize: 12 }}>remove</button>}
        </div>
      ))}
    </div>
  );
}

// ---------- data helpers ----------
const getMarksFor = (roster, classId, term) => roster.marks?.[classId]?.[termKey(term)] || { approved: false, grid: {} };

// Results move: draft → submitted (teacher) → approved (admin publishes to parents).
// Older records only had a boolean, so they map onto the new states cleanly.
const MARK_STATUS = {
  draft:     { label: "DRAFT — not yet sent to admin",        bg: "#FFF6D6", fg: "#8A6A00", border: "#F0D98A" },
  submitted: { label: "SENT FOR APPROVAL — awaiting admin",   bg: "#EFF5F1", fg: "#FFFFFF", border: "#C6D2CA" },
  approved:  { label: "APPROVED — visible to students & parents", bg: "#E3F5E9", fg: "#0E7A3C", border: "#A9DEBC" },
  returned:  { label: "RETURNED BY ADMIN — needs correction", bg: "#FDE8E6", fg: "#C0261B", border: "#F3C0BB" },
};
const statusOf = (m) => m?.status || (m?.approved ? "approved" : "draft");
const setMarksFor = (roster, classId, term, data) => ({
  ...roster,
  marks: { ...roster.marks, [classId]: { ...(roster.marks?.[classId] || {}), [termKey(term)]: data } },
});
const getAttendanceFor = (roster, classId) => roster.attendance?.[classId] || {};
const setAttendanceFor = (roster, classId, log) => ({ ...roster, attendance: { ...roster.attendance, [classId]: log } });

// ================= ROLE GATE =================
function RoleGate({ onStaffSignedIn, onParentSignedIn }) {
  // The portal may serve more than one school. The list is fetched once; when
  // there is only one, it is chosen silently and never shown — a single-school
  // portal should not ask a question with one answer.
  const [schools, setSchools] = useState(null);
  const [school, setSchool] = useState("");
  // A link like ...?school=sarif pins the portal to that one school: its name
  // on the door, no picker, no sight of anyone else. Each head teacher gets
  // their own link rather than a list of everybody's.
  const [pinned, setPinned] = useState(schoolFromUrl());
  // the crest arrives after the first paint, so a tick redraws the door
  const [, setLogoTick] = useState(0);
  useEffect(() => {
    listSchools()
      .then((rows) => {
        const list = rows || [];
        setSchools(list);
        const fromUrl = schoolFromUrl();
        if (fromUrl && list.some((x) => x.code === fromUrl)) {
          setSchool(fromUrl); setPinned(fromUrl);
          const sc = list.find((x) => x.code === fromUrl);
          applySchoolIdentity({ name: sc.name, location: sc.location });
          // the crest belongs on the door, before anyone has signed in
          logoGet(fromUrl).then((d) => {
            applySchoolLogo(d); setLogoTick((n) => n + 1);
            applyInstallIdentity(fromUrl, sc.name, d);
          }).catch(() => applyInstallIdentity(fromUrl, sc.name, ""));
          return;
        }
        setPinned("");                       // a bad code falls back to the list
        const remembered = lastSchool();
        if (list.length === 1) {
          setSchool(list[0].code);
          applySchoolIdentity({ name: list[0].name, location: list[0].location });
        } else if (remembered && list.some((x) => x.code === remembered)) {
          setSchool(remembered);
        }
      })
      .catch(() => setSchools([]));
  }, []);

  // Whichever school is chosen, the door shows its name.
  useEffect(() => {
    const sc = (schools || []).find((x) => x.code === school);
    if (!sc) return;
    applySchoolIdentity({ name: sc.name, location: sc.location });
    logoGet(sc.code).then((d) => {
      applySchoolLogo(d); setLogoTick((n) => n + 1);
      applyInstallIdentity(sc.code, sc.name, d);
    }).catch(() => applyInstallIdentity(sc.code, sc.name, ""));
  }, [school, schools]);
  const [step, setStep] = useState("root");
  const [creds, setCreds] = useState({ username: "", password: "" });
  const [adm, setAdm] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState({ stage: "ask", username: "", code: "", pw1: "", pw2: "" });
  const [note, setNote] = useState("");
  const [, forceRender] = useState(0);

  // The school's name lives in the database, so fetch it before sign-in.
  useEffect(() => {
    let cancelled = false;
    schoolInfo().then((info) => {
      if (!cancelled && info) { applySchoolIdentity(info); forceRender((n) => n + 1); }
    });
    return () => { cancelled = true; };
  }, []);

  const sendCode = async () => {
    const u = reset.username.trim() || creds.username.trim();
    if (!u) return setErr("Enter your username or email first.");
    setBusy(true); setErr(""); setNote("");
    try {
      await requestReset(u);
      setReset({ ...reset, username: u, stage: "code" });
      setNote("If that account has an email on file, a 6-digit code is on its way. It expires in 20 minutes. "
        + "If nothing arrives, the account has no email on it — ask the head teacher for a new password, "
        + "then add your email under My password so this works next time.");
    } catch (e) {
      setErr(String(e.message || e).slice(0, 180));
    }
    setBusy(false);
  };

  const applyReset = async () => {
    if (!reset.code.trim()) return setErr("Enter the code from the email.");
    const problem = passwordProblem(reset.pw1, reset.username);
    if (problem) return setErr(problem);
    if (reset.pw1 !== reset.pw2) return setErr("The two passwords do not match.");
    setBusy(true); setErr(""); setNote("");
    try {
      const ok = await confirmReset(reset.username, reset.code, reset.pw1);
      if (!ok) { setErr("That code is wrong or has expired."); setBusy(false); return; }
      setNote("Password changed. You can sign in now.");
      setCreds({ username: reset.username, password: "" });
      setReset({ stage: "ask", username: "", code: "", pw1: "", pw2: "" });
      setStep("staff");
    } catch (e) {
      setErr(String(e.message || e).slice(0, 180));
    }
    setBusy(false);
  };

  // One sign-in for all staff. The database decides whether this person is
  // an admin or a teacher — the app no longer takes their word for it.
  const signIn = async () => {
    if (!school) return setErr("Choose your school.");
    if (!creds.username.trim() || !creds.password) return setErr("Enter your username and password.");
    setBusy(true); setErr("");
    try {
      const session = await staffLogin(school, creds.username, creds.password);
      if (!session) { setErr("School, username or password not recognised."); setBusy(false); return; }
      await onStaffSignedIn(session);
    } catch (e) {
      // Show the real reason — a generic message makes problems impossible to diagnose.
      setErr(isOffline()
        ? "You are offline — sign in once with a connection."
        : "Sign-in failed: " + String(e.message || e).slice(0, 180));
      setBusy(false);
    }
  };

  const parentSignIn = async () => {
    if (!adm.trim() || !pin.trim()) return setErr("Enter the admission number and PIN.");
    setBusy(true); setErr("");
    try {
      const payload = await parentLookup(adm.trim(), pin.trim());
      if (!payload) { setErr("Admission number or PIN not recognised."); setBusy(false); return; }
      // kept so the family can fetch and send holiday work, which checks the
      // pair on every call rather than trusting a session
      onParentSignedIn({ ...payload, _adm: adm.trim(), _pin: pin.trim() });
    } catch (e) {
      setErr(isOffline()
        ? "You are offline — a connection is needed to view results."
        : "Lookup failed: " + String(e.message || e).slice(0, 180));
      setBusy(false);
    }
  };

  return (
    <>
    <div className="gate-bg" />
    <div className="rise" style={{ position: "relative", maxWidth: 430, margin: "0 auto", padding: "6vh 20px 44px" }}>
      <div style={{ textAlign: "center", marginBottom: 30 }}>
        <div style={{
          width: 84, height: 84, margin: "0 auto", borderRadius: "50%",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "#FFFFFF", border: "1px solid #DCE6E0",
          boxShadow: "0 0 0 6px rgba(232,178,61,0.07), 0 10px 26px rgba(0,0,0,0.35)",
        }}>
          <Seal size={52} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0 0" }}>
          <span className="rule" /><span style={{ fontFamily: FONT.mono, color: "#5E6E64", fontSize: 9.5, letterSpacing: 2, whiteSpace: "nowrap" }}>REPUBLIC OF KENYA</span><span className="rule" />
        </div>
        <div style={{ fontFamily: FONT.mono, color: "#5E6E64", fontSize: 9.5, letterSpacing: 2, marginTop: 5 }}>MINISTRY OF EDUCATION</div>
        <h1 style={{ fontFamily: FONT.display, color: "#0A2E1A", fontSize: 25, margin: "12px 0 0", fontWeight: 700, lineHeight: 1.22 }}>{SCHOOL_NAME}</h1>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 7, marginTop: 9, padding: "4px 12px", borderRadius: 20, border: "1px solid #CBD6D0", background: "rgba(255,255,255,0.9)" }}>
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#FFC400" }} />
          <span style={{ fontFamily: FONT.mono, color: "#0B5C2D", fontSize: 11, letterSpacing: 0.8 }}>{SCHOOL_LOCATION}</span>
        </div>
      </div>

      {step === "root" && (
        <div style={{ display: "grid", gap: 12 }}>
          <InstallPrompt />

          <RoleCard glyph="S" title="Staff Login" desc="Teachers and administration — sign in with your username." onClick={() => { setStep("staff"); setErr(""); }} />
          <RoleCard glyph="P" title="Student / Parent" desc="Results with class position, attendance and fees." onClick={() => { setStep("parent"); setErr(""); }} />
        </div>
      )}

      {step === "staff" && (
        <div>
          <button onClick={() => { setStep("root"); setErr(""); }} style={backBtnStyle()}>← back</button>
          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            {/* Only asked when there is more than one school. A portal serving
                one school should not put a question with one answer in the way. */}
            {schools && schools.length > 1 && !pinned && (
              <select value={school} onChange={(e) => { setSchool(e.target.value); setErr(""); }}
                style={{ ...inputStyle(), fontWeight: school ? 600 : 400 }}>
                <option value="">Choose your school…</option>
                {schools.map((sc) => (
                  <option key={sc.code} value={sc.code}>
                    {sc.name}{sc.location ? ` — ${sc.location}` : ""}
                  </option>
                ))}
              </select>
            )}
            <input placeholder="Username" autoCapitalize="none" value={creds.username}
              onChange={(e) => setCreds({ ...creds, username: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && signIn()} style={inputStyle()} />
            <input placeholder="Password" type="password" value={creds.password}
              onChange={(e) => setCreds({ ...creds, password: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && signIn()} style={inputStyle()} />
            {err && <div style={{ color: "#F08E80", fontFamily: FONT.mono, fontSize: 12 }}>{err}</div>}
            <button onClick={signIn} disabled={busy} style={{ ...primaryBtn(), background: "#FFC400", color: "#0A2E1A", opacity: busy ? 0.6 : 1 }}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            {note && <div style={{ color: "#7BD79B", fontFamily: FONT.body, fontSize: 12, lineHeight: 1.5 }}>{note}</div>}
            <button onClick={() => { setStep("forgot"); setErr(""); setNote(""); setReset({ ...reset, username: creds.username, stage: "ask" }); }}
              style={{ ...backBtnStyle(), marginTop: 6, textAlign: "left" }}>
              Forgotten your password?
            </button>
          </div>
        </div>
      )}

      {step === "forgot" && (
        <div>
          <button onClick={() => { setStep("staff"); setErr(""); }} style={backBtnStyle()}>← back to sign in</button>
          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            <div style={{ fontFamily: FONT.display, color: "#0A2E1A", fontSize: 17, fontWeight: 700 }}>Reset your password</div>

            {reset.stage === "ask" && (
              <>
                <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#A8BCAC", lineHeight: 1.5 }}>
                  Enter your username. If an email address is on file for it, we'll send a 6-digit code.
                </div>
                <input placeholder="Username or email" autoCapitalize="none" value={reset.username}
                  onChange={(e) => setReset({ ...reset, username: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && sendCode()} style={inputStyle()} />
                {err && <div style={{ color: "#F08E80", fontFamily: FONT.mono, fontSize: 12 }}>{err}</div>}
                {note && <div style={{ color: "#7BD79B", fontFamily: FONT.body, fontSize: 12, lineHeight: 1.5 }}>{note}</div>}
                <button onClick={sendCode} disabled={busy} style={{ ...primaryBtn(), background: "#FFC400", color: "#0A2E1A", opacity: busy ? 0.6 : 1 }}>
                  {busy ? "Sending…" : "Send code"}
                </button>
                <div style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#5E6E64", marginTop: 4, lineHeight: 1.5 }}>
                  No email on your account? The school administrator can set a new password for you.
                </div>
              </>
            )}

            {reset.stage === "code" && (
              <>
                {note && <div style={{ color: "#7BD79B", fontFamily: FONT.body, fontSize: 12, lineHeight: 1.5 }}>{note}</div>}
                <input placeholder="6-digit code" inputMode="numeric" value={reset.code}
                  onChange={(e) => setReset({ ...reset, code: e.target.value })} style={inputStyle()} />
                <input placeholder="New password" type="password" value={reset.pw1}
                  onChange={(e) => setReset({ ...reset, pw1: e.target.value })} style={inputStyle()} />
                <input placeholder="Repeat new password" type="password" value={reset.pw2}
                  onChange={(e) => setReset({ ...reset, pw2: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && applyReset()} style={inputStyle()} />
                {err && <div style={{ color: "#F08E80", fontFamily: FONT.mono, fontSize: 12 }}>{err}</div>}
                <button onClick={applyReset} disabled={busy} style={{ ...primaryBtn(), background: "#FFC400", color: "#0A2E1A", opacity: busy ? 0.6 : 1 }}>
                  {busy ? "Saving…" : "Set new password"}
                </button>
                <button onClick={sendCode} disabled={busy} style={{ ...backBtnStyle(), marginTop: 4, textAlign: "left" }}>Send another code</button>
              </>
            )}
          </div>
        </div>
      )}

      {step === "parent" && (
        <div>
          <button onClick={() => { setStep("root"); setErr(""); }} style={backBtnStyle()}>← back</button>
          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            <div style={{ fontFamily: FONT.body, fontSize: 12.5, color: "#A8BCAC", lineHeight: 1.5 }}>
              Enter the admission number and PIN printed on your child's report card.
            </div>
            <input placeholder="Admission number (e.g. STU/2026/001)" autoCapitalize="characters" value={adm}
              onChange={(e) => setAdm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && parentSignIn()} style={inputStyle()} />
            <input placeholder="PIN" type="password" inputMode="numeric" value={pin}
              onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => e.key === "Enter" && parentSignIn()} style={inputStyle()} />
            {err && <div style={{ color: "#F08E80", fontFamily: FONT.mono, fontSize: 12 }}>{err}</div>}
            <button onClick={parentSignIn} disabled={busy} style={{ ...primaryBtn(), background: "#FFC400", color: "#0A2E1A", opacity: busy ? 0.6 : 1 }}>
              {busy ? "Checking…" : "View results"}
            </button>
            <div style={{ fontFamily: FONT.body, fontSize: 11.5, color: "#5E6E64", marginTop: 4 }}>
              Lost the PIN? Ask the school office.
            </div>
          </div>
        </div>
      )}

      <div style={{ textAlign: "center", marginTop: 34, fontFamily: FONT.mono, fontSize: 9.5, color: "#0B5C2D", letterSpacing: 1 }}>
        {SCHOOL_MOTTO}
        <div style={{ marginTop: 6, fontSize: 9, color: "#8A968E", letterSpacing: 0.6 }}>{APP_VERSION}</div>
      </div>
    </div>
    </>
  );
}

function RoleCard({ title, desc, onClick, glyph }) {
  // On a black ground a card has to be lifted, not tinted — a nearly-black
  // panel on black reads as a smudge. This one is plainly a surface, with a
  // yellow mark that only appears under the finger.
  return (
    <button onClick={onClick} className="role-card lift" style={{
      display: "flex", alignItems: "center", gap: 14, width: "100%", textAlign: "left",
      background: "#FFFFFF", border: "1px solid #DCE6E0", borderRadius: 10,
      padding: "16px 17px", color: "#0A2E1A",
      boxShadow: "0 2px 10px rgba(0,0,0,0.06)", position: "relative", overflow: "hidden",
    }}>
      <span style={{
        flex: "0 0 auto", width: 44, height: 44, borderRadius: 10,
        background: "#FFC400", display: "flex", alignItems: "center", justifyContent: "center",
        color: "#0A2E1A", fontFamily: FONT.mono, fontSize: 18, fontWeight: 800,
      }}>{glyph}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontFamily: FONT.display, fontSize: 18.5,
              fontWeight: 700, letterSpacing: 0.2 }}>{title}</span>
        <span style={{ display: "block", fontFamily: FONT.body, fontSize: 12.5,
              color: "#5E6E64", marginTop: 3, lineHeight: 1.4 }}>{desc}</span>
      </span>
      <span style={{ flex: "0 0 auto", color: "#0E7A3C", fontSize: 22, fontFamily: FONT.body }}>›</span>
    </button>
  );
}


// ---------- Icons for the navigation drawer ----------
const NavIcon = ({ d, size = 17 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 auto" }}>
    {d}
  </svg>
);
const ICONS = {
  overview:  <><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></>,
  approvals: <><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></>,
  logins:    <><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>,
  classes:   <><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/></>,
  subjects:  <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></>,
  teachers:  <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></>,
  staff:     <><path d="M9 11H3v10h6z"/><path d="M15 3H9v18h6z"/><path d="M21 7h-6v14h6z"/></>,
  students:  <><path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"/></>,
  marks:     <><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></>,
  timetable: <><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></>,
  duty:      <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  fees:      <><circle cx="12" cy="12" r="9"/><path d="M15 9.5a3 3 0 0 0-3-1.5c-1.7 0-3 .9-3 2s1.3 2 3 2 3 .9 3 2-1.3 2-3 2a3 3 0 0 1-3-1.5"/><path d="M12 6v12"/></>,
  reports:   <><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></>,
  yearend:   <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></>,
  backup:    <><path d="M21 8v13H3V8"/><rect x="1" y="3" width="22" height="5" rx="1"/><path d="M10 12h4"/></>,
  settings:  <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.6 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H7a1.7 1.7 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V7a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></>,
  attendance:<><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></>,
};

// Grouped navigation drawer, in the style of a university student portal.
function Sidebar({ open, onClose, groups, active, onPick, heading, subheading }) {
  // Thirty-one items in one scroll is a wall. Each heading now opens and
  // closes, and only one stays open at a time — so the menu is a short list of
  // six topics until you choose one. The group holding the current screen
  // opens itself, so you always land where you already are.
  const groupOf = (key) => groups.find((g) => g.items.some((i) => i.key === key))?.title;
  const [openGroup, setOpenGroup] = useState(groupOf(active) || groups[0]?.title);

  // following a link from elsewhere in the app should open the right group
  useEffect(() => { const g = groupOf(active); if (g) setOpenGroup(g); }, [active]);

  return (
    <>
      <div onClick={onClose} className="no-print" style={{
        position: "fixed", inset: 0, background: "rgba(10,20,15,0.35)", zIndex: 200,
        opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none", transition: "opacity .22s ease",
      }} />
      <nav className="no-print" style={{
        position: "fixed", top: 0, left: 0, bottom: 0, width: 268, maxWidth: "84vw", zIndex: 201,
        background: "#FFFFFF", borderRight: "1px solid #DCE6E0",
        transform: open ? "translateX(0)" : "translateX(-102%)", transition: "transform .24s cubic-bezier(.2,.7,.3,1)",
        overflowY: "auto", boxShadow: open ? "6px 0 24px rgba(0,0,0,0.35)" : "none",
      }}>
        <div style={{ padding: "18px 18px 14px", borderBottom: "1px solid #E1E7E3", display: "flex", alignItems: "center", gap: 11 }}>
          <Seal size={34} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: FONT.display, color: "#0A2E1A", fontSize: 15.5, fontWeight: 700, lineHeight: 1.2 }}>{heading}</div>
            <div style={{ fontFamily: FONT.mono, color: "#5E6E64", fontSize: 10, marginTop: 2 }}>{subheading}</div>
          </div>
        </div>

        <div style={{ padding: "8px 0 26px" }}>
          {groups.map((g) => {
            const isOpen = openGroup === g.title;
            const holdsActive = g.items.some((i) => i.key === active);
            // a count on a closed heading, so nothing waiting is hidden by it
            const waiting = g.items.reduce((n, i) => n + (i.badge || 0), 0);

            return (
              <div key={g.title}>
                <button
                  onClick={() => setOpenGroup(isOpen ? null : g.title)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
                    padding: "13px 18px", border: "none", cursor: "pointer",
                    background: isOpen ? "#F4F8F5" : "transparent",
                    borderLeft: `3px solid ${holdsActive && !isOpen ? "#0E7A3C" : "transparent"}`,
                  }}>
                  <span style={{ flex: 1, fontFamily: FONT.display, fontSize: 13,
                        fontWeight: 700, letterSpacing: 0.2,
                        color: isOpen ? "#0A2E1A" : "#4A5A50" }}>
                    {g.title.charAt(0) + g.title.slice(1).toLowerCase()}
                  </span>
                  {waiting > 0 && !isOpen && (
                    <span style={{ background: "#FFC400", color: "#0A2E1A", borderRadius: 10,
                          padding: "1px 8px", fontFamily: FONT.mono, fontSize: 10, fontWeight: 800 }}>
                      {waiting}
                    </span>
                  )}
                  <span style={{ color: "#8A968E", fontSize: 11, transition: "transform .2s ease",
                        transform: isOpen ? "rotate(90deg)" : "none", display: "inline-block" }}>▶</span>
                </button>

                {isOpen && g.items.map((it) => {
                  const on = active === it.key;
                  return (
                    <button key={it.key} onClick={() => { onPick(it.key); onClose(); }} style={{
                      display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left",
                      padding: "10px 18px 10px 24px", border: "none",
                      background: on ? "#E3F5E9" : "transparent",
                      borderLeft: `3px solid ${on ? "#0E7A3C" : "transparent"}`,
                      color: on ? "#0B5C2D" : "#4A5A50", fontFamily: FONT.body, fontSize: 13.5,
                      fontWeight: on ? 600 : 400,
                    }}>
                      <span style={{ color: on ? "#0E7A3C" : "#8A968E", display: "flex" }}><NavIcon d={ICONS[it.icon] || ICONS.overview} /></span>
                      <span style={{ flex: 1 }}>{it.label}</span>
                      {it.badge > 0 && (
                        <span style={{ background: "#FFC400", color: "#0A2E1A", borderRadius: 10,
                              padding: "1px 8px", fontFamily: FONT.mono, fontSize: 10, fontWeight: 800 }}>{it.badge}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </nav>
    </>
  );
}

// Header bar with the menu button and the current section name.
function PortalHeader({ title, section, onMenu, onExit, badge = 0 }) {
  return (
    <div className="no-print" style={{
      display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
      background: "rgba(255,255,255,0.97)", borderBottom: "1px solid #DCE6E0",
      position: "sticky", top: 0, zIndex: 120, backdropFilter: "blur(6px)",
    }}>
      <button onClick={onMenu} aria-label={badge > 0 ? `Menu — ${badge} waiting for approval` : "Menu"}
        style={{
          display: "flex", flexDirection: "column", gap: 4, background: "transparent",
          border: "1px solid #CBD6D0", borderRadius: 6, padding: "9px 10px", position: "relative",
        }}>
        {[0, 1, 2].map((i) => <span key={i} style={{ width: 16, height: 2, background: "#FFC400", borderRadius: 2, display: "block" }} />)}
        {/* a count here means it is visible from every screen, not only the dashboard */}
        {badge > 0 && (
          <span className="pulse alert-dot" style={{
            position: "absolute", top: -7, right: -7, background: "#FFC400", color: "#0A2E1A",
            borderRadius: 10, minWidth: 19, height: 19, display: "grid", placeItems: "center",
            fontFamily: FONT.mono, fontSize: 10.5, fontWeight: 800, padding: "0 5px",
            border: "2px solid #FFFFFF",
          }}>{badge > 99 ? "99+" : badge}</span>
        )}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: FONT.mono, color: "#5E6E64", fontSize: 9.5, letterSpacing: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
        <div style={{ fontFamily: FONT.display, color: "#0A2E1A", fontSize: 17, fontWeight: 700, textTransform: "capitalize" }}>{section}</div>
      </div>
      <button onClick={onExit} style={{ background: "#FFFFFF", border: "1px solid #C6D2CA", color: "#0A2E1A", borderRadius: 4, padding: "7px 12px", fontFamily: FONT.body, fontSize: 12, whiteSpace: "nowrap" }}>Sign out</button>
    </div>
  );
}

// ================= ADMIN =================
function AdminView({ roster, saveRoster, onExit, syncState, onForceSave, who }) {
  const [tab, setTab] = useState("overview");
  const [newClass, setNewClass] = useState("");
  const [newSubject, setNewSubject] = useState("");
  const [newTeacher, setNewTeacher] = useState({
    firstName: "", surname: "", classId: "", username: "", password: "",
    tsc: "", email: "", phone: "", idNumber: "", qualification: "",
  });
  const [showTeacherMore, setShowTeacherMore] = useState(false);
  const BLANK_STUDENT = {
    admNo: "",                             // blank means "give it the next one"
    firstName: "", middleName: "", surname: "", classId: "",
    sex: "", dob: "", birthCertNo: "", nationality: "Kenyan", assessmentNo: "",
    county: "", subCounty: "", ward: "", homeArea: "",
    parentName: "", parentRelation: "Parent", parentId: "", parentPhone: "",
    parentEmail: "", altPhone: "",
    medical: "", feeDue: "", boarder: false,
  };
  const [newStudent, setNewStudent] = useState(BLANK_STUDENT);
  const [lastAddedClassId, setLastAddedClassId] = useState("");
  const [newAdminPass, setNewAdminPass] = useState("");
  const [payment, setPayment] = useState({ studentId: "", amount: "", method: "cash", code: "", sender: "" });
  const [payErr, setPayErr] = useState("");
  const [payBusy, setPayBusy] = useState(false);
  const [marksClassId, setMarksClassId] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [receipt, setReceipt] = useState(null);   // { student, payment } to print
  const cur = roster.settings.currency;

  // Everything anyone is waiting on the administrator for. Gathered in one
  // place because five separate queues is how a request gets forgotten.
  const [leaveRows, setLeaveRows] = useState([]);
  useEffect(() => {
    let live = true;
    const pull = () => leaveList(true)
      .then((r) => { if (live) setLeaveRows(r || []); })
      .catch(() => {});
    pull();
    const t = setInterval(pull, 60000);        // refresh while the page is open
    return () => { live = false; clearInterval(t); };
  }, []);

  let pendingCount = 0;
  Object.values(roster.marks || {}).forEach((terms) =>
    Object.values(terms || {}).forEach((rec) => { if (statusOf(rec) === "submitted") pendingCount++; }));

  const today = todayISO();
  const pendingLeave = leaveRows.filter((r) => r.status === "pending");
  const pendingDiscipline = (roster.discipline || []).filter((d) => (d.status || "open") === "open");
  const pendingArrivals = Object.values(roster.checkins?.[today] || {})
    .filter((c) => c && (c.approved === null || (c.outStatus === "early" && c.outApproved === null)));

  const ALERTS = [
    { key: "approvals",  n: pendingCount,            tone: "#C0261B",
      one: "set of results waiting to be published", many: "sets of results waiting to be published",
      why: "A teacher has sent marks and cannot publish them" },
    { key: "leave",      n: pendingLeave.length,     tone: "#8A6A00",
      one: "leave application to decide", many: "leave applications to decide",
      why: "Staff cannot plan until you answer" },
    { key: "discipline", n: pendingDiscipline.length, tone: "#0B5C2D",
      one: "discipline case to review", many: "discipline cases to review",
      why: "A teacher has reported an incident" },
    { key: "signins",    n: pendingArrivals.length,  tone: "#0A2E1A",
      one: "arrival or departure to approve", many: "arrivals or departures to approve",
      why: "Late arrivals and early departures need your decision" },
  ].filter((a) => a.n > 0);

  const alertTotal = ALERTS.reduce((a, x) => a + x.n, 0);

  const NAV = [
    { title: "DASHBOARD", items: [
      { key: "overview", label: "Overview", icon: "overview" },
      { key: "approvals", label: "Approvals", icon: "approvals", badge: pendingCount },
      { key: "memos", label: "Memos to staff", icon: "subjects" },
      { key: "leave", label: "Leave applications", icon: "duty", badge: pendingLeave.length },
    ]},
    (who?.institutionType === "college"
      ? { title: "ACADEMICS", items: [
          { key: "units", label: "Units", icon: "marks" },
          { key: "collegett", label: "Timetable", icon: "timetable" },
          { key: "studentdocs", label: "Fee statement / exam card", icon: "reports" },
        ]}
      : { title: "ACADEMICS", items: [
          { key: "marks", label: "Exam results", icon: "marks" },
          { key: "timetable", label: "Class timetable", icon: "timetable" },
          { key: "examtt", label: "Exam timetable", icon: "marks" },
          { key: "subjects", label: "Subjects", icon: "subjects" },
          { key: "classes", label: "Classes", icon: "classes" },
        ]}
    ),
    (who?.institutionType === "college"
      ? { title: "PEOPLE", items: [
          { key: "students", label: "Students", icon: "students" },
          { key: "logins", label: "Staff logins", icon: "logins" },
        ]}
      : { title: "PEOPLE", items: [
          { key: "students", label: "Students", icon: "students" },
          { key: "discipline", label: "Discipline cases", icon: "approvals", badge: pendingDiscipline.length },
          { key: "photos", label: "Pupil photos", icon: "students" },
          { key: "idcards", label: "Student ID cards", icon: "logins" },
          { key: "scan", label: "Scan a card", icon: "logins" },
          { key: "signins", label: "Arrival sign-ins", icon: "duty", badge: pendingArrivals.length },
          { key: "printreg", label: "Print the register", icon: "reports" },
          { key: "teachers", label: "Teachers", icon: "teachers" },
          { key: "logins", label: "Staff logins", icon: "logins" },
          { key: "staff", label: "Staff attendance", icon: "staff" },
          { key: "duty", label: "Duty roster", icon: "duty" },
        ]}
    ),
    { title: "FINANCIALS", items: [
      { key: "fees", label: "Fees & receipts", icon: "fees" },
      { key: "feeroll", label: "Printable fee list", icon: "reports" },
      { key: "spending", label: "Where money went", icon: "reports" },
    ]},
    { title: "REPORTS", items: [
      { key: "reports", label: "Reports", icon: "reports" },
      { key: "import", label: "Bring in records", icon: "backup" },
      { key: "year end", label: "End of year", icon: "yearend" },
      { key: "history", label: "History", icon: "reports" },
      { key: "holidaywork", label: "Holiday work", icon: "subjects" },
    ]},
    { title: "SYSTEM", items: [
      { key: "health", label: "System health", icon: "approvals" },
      { key: "logo", label: "The school's crest", icon: "students" },
      { key: "geofence", label: "School boundary", icon: "duty" },
      { key: "security", label: "Security", icon: "logins" },
      ...(who?.isOwner ? [{ key: "schools", label: "Schools", icon: "overview" }] : []),
      { key: "mypassword", label: "My password", icon: "logins" },
      { key: "backup", label: "Backup", icon: "backup" },
      { key: "settings", label: "Settings", icon: "settings" },
    ]},
  ];

  const addClass = () => {
    if (!newClass.trim()) return;
    saveRoster({ ...roster, classes: [...roster.classes, { id: genId("CLS", roster.classes), name: newClass.trim() }] }, `Added ${newClass.trim()}`);
    setNewClass("");
  };
  const addSubject = () => {
    const s = newSubject.trim();
    if (!s || roster.subjects.some((x) => x.toLowerCase() === s.toLowerCase())) return;
    saveRoster({ ...roster, subjects: [...roster.subjects, s] }, `Added ${s}`);
    setNewSubject("");
  };
  const addTeacher = () => {
    const n = newTeacher;
    if (!n.firstName.trim() || !n.surname.trim() || !n.classId) return;
    const display = `${n.firstName.trim()} ${n.surname.trim()}`;
    const username = n.username.trim() || slugUser(display);
    if (roster.teachers.some((t) => t.username?.toLowerCase() === username.toLowerCase())) return;
    const password = n.password.trim() || Math.random().toString(36).slice(2, 8);
    const t = {
      id: genId("TCH", roster.teachers),
      name: display,                      // kept so every existing screen works
      firstName: n.firstName.trim(),
      surname: n.surname.trim(),
      classId: n.classId, username, password, subjects: [],
      tsc: n.tsc.trim() || undefined,
      email: n.email.trim() || undefined,
      phone: n.phone.trim() || undefined,
      idNumber: n.idNumber.trim() || undefined,
      qualification: n.qualification.trim() || undefined,
      joinedOn: todayISO(),
    };
    saveRoster({ ...roster, teachers: [...roster.teachers, t] },
      `${display} — login: ${username} / ${password}`);
    setNewTeacher({ firstName: "", surname: "", classId: "", username: "", password: "",
      tsc: "", email: "", phone: "", idNumber: "", qualification: "" });
  };
  const addStudent = () => {
    const n = newStudent;
    if (!n.firstName.trim() || !n.surname.trim() || !n.classId) return;
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    const display = [n.firstName, n.middleName, n.surname]
      .map((x) => x.trim()).filter(Boolean).join(" ");
    const keep = (v) => { const t = String(v ?? "").trim(); return t === "" ? undefined : t; };

    // A school that already numbers its pupils keeps its own numbers; one that
    // does not gets the next in sequence. Either way the number is what every
    // mark, receipt and parent PIN hangs from, so it must be right.
    const typed = String(n.admNo || "").trim();
    if (typed && roster.students.some((x) => String(x.id).toLowerCase() === typed.toLowerCase())) {
      const owner = roster.students.find((x) => String(x.id).toLowerCase() === typed.toLowerCase());
      window.alert(`Admission number ${typed} already belongs to ${owner.name}.`);
      // Clear it, so the next pupil is not accidentally given the same number
      // again by a clerk who taps straight past the warning.
      setNewStudent({ ...n, admNo: "" });
      return;
    }

    const s = {
      id: typed || nextAdmissionNo(roster.students),
      name: display,                       // kept so every existing screen works
      firstName: n.firstName.trim(),
      middleName: keep(n.middleName),
      surname: n.surname.trim(),
      classId: n.classId,
      sex: n.sex || undefined,
      dob: keep(n.dob),
      birthCertNo: keep(n.birthCertNo),
      nationality: keep(n.nationality) || "Kenyan",
      assessmentNo: keep(n.assessmentNo),
      county: keep(n.county),
      subCounty: keep(n.subCounty),
      ward: keep(n.ward),
      homeArea: keep(n.homeArea),
      parentName: n.parentName.trim(),
      parentRelation: n.parentRelation || undefined,
      parentId: keep(n.parentId),
      parentPhone: keep(n.parentPhone),
      parentEmail: keep(n.parentEmail),
      altPhone: keep(n.altPhone),
      medical: keep(n.medical),
      boarder: n.boarder || undefined,
      feeDue: Number(n.feeDue) || 0, feePaid: 0, payments: [], pin,
      admittedOn: todayISO(),
    };
    saveRoster(logAction({ ...roster, students: [...roster.students, s] }, "Admin",
      `Added student ${display} (${s.id})`), `Added ${display} — PIN ${pin}`);
    setLastAddedClassId(s.classId);
    // The class, fee and where the family lives usually repeat down a queue of
    // families from the same village, so those stay filled.
    setNewStudent({ ...BLANK_STUDENT, classId: n.classId, feeDue: n.feeDue,
      county: n.county, subCounty: n.subCounty, ward: n.ward });
  };

  const removeItem = (kind, id) => saveRoster({ ...roster, [kind]: roster[kind].filter((x) => x.id !== id) }, "Removed");
  const toggleTeacherSubject = (teacherId, subject) => {
    saveRoster({
      ...roster,
      teachers: roster.teachers.map((t) => {
        if (t.id !== teacherId) return t;
        const subs = t.subjects || [];
        return { ...t, subjects: subs.includes(subject) ? subs.filter((s) => s !== subject) : [...subs, subject] };
      }),
    });
  };
  const resetTeacherPassword = (id) => {
    const pw = Math.random().toString(36).slice(2, 8);
    const t = roster.teachers.find((x) => x.id === id);
    saveRoster({ ...roster, teachers: roster.teachers.map((x) => x.id === id ? { ...x, password: pw } : x) }, `${t?.name}'s new password: ${pw}`);
  };
  const setFeeDue = (id, val) => saveRoster({ ...roster, students: roster.students.map((s) => s.id === id ? { ...s, feeDue: Number(val) || 0 } : s) });
  const recordPayment = async () => {
    const amt = Number(payment.amount);
    if (!payment.studentId || !amt || amt <= 0) return;
    const st = roster.students.find((s) => s.id === payment.studentId);
    const receiptNo = nextReceiptNo(roster);
    setPayErr(""); setPayBusy(true);

    // For M-Pesa, claim the confirmation code first. If it has been used
    // before the claim fails and no payment is recorded, so the books cannot
    // be inflated by entering the same SMS twice.
    let code = "";
    if (payment.method === "mpesa") {
      if (!payment.code.trim()) { setPayErr("Enter the M-Pesa confirmation code from the SMS."); setPayBusy(false); return; }
      try {
        code = await mpesaClaim(payment.code, payment.studentId, amt, todayISO(), payment.sender);
      } catch (e) {
        setPayErr(String(e.message || e).replace(/^mpesa_claim \d+: /, "").slice(0, 200));
        setPayBusy(false);
        return;
      }
    }

    const entry = { date: todayISO(), amount: amt, receiptNo, method: payment.method };
    if (code) { entry.mpesaCode = code; if (payment.sender.trim()) entry.sender = payment.sender.trim(); }

    const next = {
      ...roster,
      students: roster.students.map((s) => s.id === payment.studentId
        ? { ...s, feePaid: (s.feePaid || 0) + amt, payments: [...(s.payments || []), entry] } : s),
    };
    saveRoster(logAction(next, "Admin",
      `Receipt ${receiptNo} — ${cur}${money(amt)} from ${st?.name}${code ? " (M-Pesa " + code + ")" : " (cash)"}`),
      `${receiptNo} · ${cur}${money(amt)} from ${st?.name}`);
    setPayment({ studentId: "", amount: "", method: payment.method, code: "", sender: "" });
    setPayBusy(false);
  };

  if (receipt) {
    return <ReceiptDoc roster={roster} student={receipt.student} payment={receipt.payment}
             onBack={() => setReceipt(null)} />;
  }

  return (
    <div>
      <PortalHeader title={SCHOOL_NAME.toUpperCase()} section={NAV.flatMap((g) => g.items).find((i) => i.key === tab)?.label || tab}
        onMenu={() => setMenuOpen(true)} onExit={onExit} badge={alertTotal} />
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} groups={NAV} active={tab} onPick={setTab}
        heading="Administration" subheading={who?.name || "Signed in"} />
      <div style={{ maxWidth: "min(1240px, 100%)", margin: "0 auto", padding: "18px 14px 70px" }}>
        <div style={{ ...paperPanel(), padding: 22 }} className="chalk-fade paper-panel">

          {tab === "overview" && (
            <>
              <PendingAlerts alerts={ALERTS} total={alertTotal} onGo={setTab} />
              <AdminOverview roster={roster} />
            </>
          )}

          {tab === "approvals" && <Approvals roster={roster} saveRoster={saveRoster} />}

          {tab === "memos" && <MemoBoard roster={roster} saveRoster={saveRoster} who={who} />}

          {tab === "leave" && <LeaveApprovals roster={roster} />}

          {tab === "logins" && <StaffAccounts roster={roster} who={who} />}

          {tab === "discipline" && <DisciplineReport roster={roster} saveRoster={saveRoster} classId={null} actorName="Admin" role="admin" />}

          {tab === "signins" && <CheckInApprovals roster={roster} saveRoster={saveRoster} />}

          {tab === "printreg" && <AdminRegister roster={roster} />}

          {tab === "photos" && <PhotoManager roster={roster} class
