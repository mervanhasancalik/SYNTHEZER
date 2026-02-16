-- Synthezer Database Schema
-- Local-first pipeline storage

-- Main pipeline record
CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  name TEXT DEFAULT 'Untitled Pipeline',
  description TEXT DEFAULT '',
  focus_tags TEXT DEFAULT '',
  current_stage INTEGER DEFAULT 1,
  status TEXT DEFAULT 'draft',
  locked_gates TEXT DEFAULT '[]',
  ai_model TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- Stage 1: Input (User fills this)
CREATE TABLE IF NOT EXISTS stage1_input (
  pipeline_id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  ai_mind TEXT DEFAULT '[]',
  prerequisites TEXT DEFAULT '[]',
  implementation_area TEXT DEFAULT '[]',
  tools TEXT DEFAULT '[]',
  no_go_rules TEXT DEFAULT '[]',
  images TEXT DEFAULT '[]',
  submitted_at INTEGER,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
);

-- Stage 2: Understanding (AI + User)
CREATE TABLE IF NOT EXISTS stage2_understanding (
  pipeline_id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'pending',
  ai_questions TEXT DEFAULT '[]',
  user_answers TEXT,
  communication_log TEXT DEFAULT '[]',
  master_prompt TEXT,
  completed_at INTEGER,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
);

-- Stage 3: Research (AI + User)
CREATE TABLE IF NOT EXISTS stage3_research (
  pipeline_id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'pending',
  ai_research_question TEXT,
  research_areas TEXT DEFAULT '[]',
  user_research_answer TEXT,
  research_master_guide TEXT,
  communication_log TEXT DEFAULT '[]',
  completed_at INTEGER,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
);

-- Stage 4: Implementation (AI + User)
CREATE TABLE IF NOT EXISTS stage4_implementation (
  pipeline_id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'pending',
  implementation_plan TEXT,
  implementation_notes TEXT,
  ai_feedback TEXT,
  user_feedback TEXT,
  verification_checklist TEXT DEFAULT '{"requirements":false,"no_go":false,"research":false,"prerequisites":false,"ai_mind":false}',
  subagent_tasks TEXT DEFAULT '[]',
  completed_at INTEGER,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
);

-- Stage 5: Output & Evaluation
CREATE TABLE IF NOT EXISTS stage5_output (
  pipeline_id TEXT PRIMARY KEY,
  output_short TEXT,
  output_detailed TEXT,
  pae_accuracy INTEGER,
  pae_completeness INTEGER,
  pae_confidence INTEGER,
  pae_comments TEXT,
  pae_generated_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
);

-- Chip definitions (user's library)
CREATE TABLE IF NOT EXISTS chips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  usage_count INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(category, name)
);

-- Pipeline library (saved/archived pipelines)
CREATE TABLE IF NOT EXISTS library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id TEXT,
  name TEXT,
  model TEXT,
  final_stage INTEGER,
  pae_score INTEGER,
  status TEXT,
  archived_at INTEGER DEFAULT (unixepoch()),
  snapshot TEXT,
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE SET NULL
);

-- Pipeline activity log
CREATE TABLE IF NOT EXISTS pipeline_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id TEXT NOT NULL,
  event TEXT NOT NULL,
  message TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
);

-- Chip packs (preset chip combinations)
CREATE TABLE IF NOT EXISTS chip_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  chips TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_pipelines_status ON pipelines(status);
CREATE INDEX IF NOT EXISTS idx_pipelines_updated ON pipelines(updated_at);
CREATE INDEX IF NOT EXISTS idx_chips_category ON chips(category);
CREATE INDEX IF NOT EXISTS idx_library_archived ON library(archived_at);
CREATE INDEX IF NOT EXISTS idx_pipeline_log_pipeline ON pipeline_log(pipeline_id);

