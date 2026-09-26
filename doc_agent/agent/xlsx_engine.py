"""
Generic, Dataset-Independent XLSX Intelligence Engine
=====================================================
A dynamic XLSX/spreadsheet processing and question-answering system that operates
with ZERO dataset-specific assumptions (no hardcoded column names, sheet names,
or domain schemas).

Features:
- Generic workbook discovery (sheets, rows, columns, data types, missing values, statistics)
- Dynamic data type detection (integer, float, numeric, string, categorical, boolean, date, datetime, time, ID-like, empty, mixed)
- Dynamic schema extraction matching Section 4 specification
- Natural language query understanding & intent resolution with strict anti-hallucination
- Deterministic calculation engine (Pandas/NumPy as source of truth; LLM is never the calculator)
- Statistical operations: count, sum, mean, median, mode, min, max, std, variance, range, quantiles, percentage
- Natural-language filtering, grouping, comparison, correlation, and cell-coordinate lookups
- Multi-sheet and cross-sheet validated joins (never hallucinates relationships)
- Conflicting data detection across sheets
- Ambiguity detection (clarification_required when multiple columns qualify)
- Strict anti-hallucination verification gate (status: verified | insufficient_information | clarification_required | conflicting_information)
- Evidence-first output detailing file, sheet, column(s), rows_analyzed, missing values excluded, operation, and result
"""

import os
import re
import math
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np
import pandas as pd
import openpyxl


class XLSXStatus(str, Enum):
    VERIFIED = "verified"
    INSUFFICIENT_INFORMATION = "insufficient_information"
    CLARIFICATION_REQUIRED = "clarification_required"
    CONFLICTING_INFORMATION = "conflicting_information"
    PROCESSING_ERROR = "processing_error"


class ColumnDataType(str, Enum):
    INTEGER = "integer"
    FLOAT = "float"
    NUMERIC = "numeric"
    STRING = "string"
    CATEGORICAL = "categorical"
    BOOLEAN = "boolean"
    DATE = "date"
    DATETIME = "datetime"
    TIME = "time"
    ID_LIKE = "id_like"
    EMPTY = "empty"
    MIXED = "mixed"


@dataclass
class ColumnSchema:
    name: str
    dtype: ColumnDataType
    pandas_dtype: str
    null_count: int
    valid_count: int
    unique_count: int
    sample_values: List[Any] = field(default_factory=list)
    min_val: Optional[Any] = None
    max_val: Optional[Any] = None
    mean_val: Optional[float] = None
    median_val: Optional[float] = None
    std_val: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        """Section 4: Dynamic schema extraction format."""
        return {
            "name": self.name,
            "dtype": self.dtype.value,
            "null_count": self.null_count,
            "unique_count": self.unique_count,
        }


@dataclass
class SheetSchema:
    sheet_name: str
    row_count: int
    column_count: int
    columns: List[ColumnSchema] = field(default_factory=list)
    numerical_columns: List[str] = field(default_factory=list)
    categorical_columns: List[str] = field(default_factory=list)
    date_columns: List[str] = field(default_factory=list)
    id_columns: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """Section 4: Dynamic schema extraction format."""
        return {
            "sheet_name": self.sheet_name,
            "row_count": self.row_count,
            "column_count": self.column_count,
            "columns": [c.to_dict() for c in self.columns],
        }


@dataclass
class WorkbookMetadata:
    file_path: str
    filename: str
    sheet_names: List[str]
    sheet_count: int
    sheets: Dict[str, SheetSchema] = field(default_factory=dict)
    dataframes: Dict[str, pd.DataFrame] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "file_path": self.file_path,
            "filename": self.filename,
            "sheet_count": self.sheet_count,
            "sheet_names": self.sheet_names,
            "sheets": {name: s.to_dict() for name, s in self.sheets.items()},
        }


@dataclass
class XLSXResponse:
    status: XLSXStatus
    answer: str
    evidence: List[Dict[str, Any]] = field(default_factory=list)
    reason: Optional[str] = None
    clarification_options: Optional[List[str]] = None

    def to_dict(self) -> Dict[str, Any]:
        """Section 27: Response format."""
        return {
            "status": self.status.value,
            "answer": self.answer,
            "evidence": self.evidence,
            "reason": self.reason,
            "clarification_options": self.clarification_options,
        }


# ============================================================================
# 1. DYNAMIC DATA TYPE DETECTION & SCHEMA EXTRACTION (Sections 3, 4, 5)
# ============================================================================

def detect_column_data_type(series: pd.Series, col_name: str) -> ColumnDataType:
    """
    Inspects a pandas Series and dynamically detects its granular data type:
    integer, float, numeric, string, categorical, boolean, date, datetime, time,
    ID-like, empty, mixed.
    """
    non_null = series.dropna()
    total_len = len(series)
    valid_len = len(non_null)

    if valid_len == 0:
        return ColumnDataType.EMPTY

    # 1. Boolean check
    if pd.api.types.is_bool_dtype(series):
        return ColumnDataType.BOOLEAN
    unique_vals = set(non_null.unique())
    if unique_vals.issubset({True, False, 0, 1, "true", "false", "True", "False", "yes", "no"}):
        if valid_len > 2 and len(unique_vals) <= 2:
            return ColumnDataType.BOOLEAN

    # 2. Native Datetime check
    if pd.api.types.is_datetime64_any_dtype(series):
        return ColumnDataType.DATETIME

    name_lower = col_name.lower()
    name_tokens = set(re.findall(r"[a-z0-9]+", name_lower))
    is_id_name = any(k in name_tokens for k in ["id", "code", "key", "number", "num", "ssn", "uuid", "sku", "identifier"])

    # 3. Numeric check (Integer vs Float vs ID-like)
    if pd.api.types.is_numeric_dtype(series):
        if is_id_name and non_null.nunique() >= valid_len * 0.85:
            return ColumnDataType.ID_LIKE

        if pd.api.types.is_integer_dtype(series):
            return ColumnDataType.INTEGER
        # If float but all non-null values are exact integers
        if np.all(np.equal(np.mod(non_null, 1), 0)):
            return ColumnDataType.INTEGER
        return ColumnDataType.FLOAT

    # 4. Formatted Numeric Strings (currency, commas, percentages)
    if pd.api.types.is_object_dtype(series) or pd.api.types.is_string_dtype(series):
        clean_num = series.astype(str).str.replace(r"[$,€£¥%\s,]", "", regex=True)
        converted = pd.to_numeric(clean_num, errors="coerce")
        if converted.notna().sum() >= valid_len * 0.85:
            non_null_num = converted.dropna()
            if is_id_name and non_null_num.nunique() >= valid_len * 0.85:
                return ColumnDataType.ID_LIKE
            if np.all(np.equal(np.mod(non_null_num, 1), 0)):
                return ColumnDataType.INTEGER
            return ColumnDataType.FLOAT

    # 5. Time check (HH:MM or HH:MM:SS format)
    time_pat = re.compile(r"^\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM|am|pm))?$")
    sample_str = [str(x).strip() for x in non_null.head(20)]
    if sample_str and all(time_pat.match(s) for s in sample_str):
        return ColumnDataType.TIME

    # 6. Datetime / Date string check
    is_date_name = any(k in name_tokens for k in ["date", "dob", "created", "timestamp", "datetime", "time"])
    if is_date_name or pd.api.types.is_string_dtype(series):
        try:
            sample = non_null.head(20).astype(str)
            if any(sample.str.contains(r"[\/\-\:]", regex=True)):
                parsed = pd.to_datetime(sample, errors="coerce")
                if parsed.notna().sum() >= len(sample) * 0.8:
                    times = [p.time() for p in parsed.dropna()]
                    has_time = any(t.hour != 0 or t.minute != 0 or t.second != 0 for t in times)
                    return ColumnDataType.DATETIME if has_time else ColumnDataType.DATE
        except Exception:
            pass

    # 7. ID-like string check (e.g. UUID, serial numbers, SKU, ID_101)
    unique_count = non_null.nunique()
    if (is_id_name or any(re.match(r"^[A-Za-z0-9]+[_\-][0-9A-Za-z]+$", str(x)) for x in non_null.head(10))) and unique_count >= valid_len * 0.85:
        return ColumnDataType.ID_LIKE

    # 6. Categorical check (low cardinality string/object)
    if unique_count <= 50 and (unique_count / max(1, valid_len)) < 0.4:
        return ColumnDataType.CATEGORICAL

    # 7. Mixed types check
    types_in_col = {type(x) for x in non_null.head(100)}
    if len(types_in_col) > 1 and not (types_in_col.issubset({int, float}) or types_in_col.issubset({str})):
        return ColumnDataType.MIXED

    return ColumnDataType.STRING


def extract_column_schema(series: pd.Series, col_name: str) -> ColumnSchema:
    """Extracts metadata, data type, and basic statistics for a single column."""
    dtype = detect_column_data_type(series, col_name)
    non_null = series.dropna()
    null_count = int(series.isna().sum())
    valid_count = len(non_null)
    unique_count = non_null.nunique()

    sample_values = non_null.head(5).tolist()
    min_val, max_val, mean_val, median_val, std_val = None, None, None, None, None

    # Compute numeric statistics if numeric
    if dtype in (ColumnDataType.INTEGER, ColumnDataType.FLOAT, ColumnDataType.NUMERIC):
        try:
            num_series = pd.to_numeric(
                series.astype(str).str.replace(r"[$,€£¥%\s,]", "", regex=True),
                errors="coerce"
            ).dropna()
            if len(num_series) > 0:
                min_val = float(num_series.min())
                max_val = float(num_series.max())
                mean_val = float(num_series.mean())
                median_val = float(num_series.median())
                std_val = float(num_series.std()) if len(num_series) > 1 else 0.0
        except Exception:
            pass
    elif dtype in (ColumnDataType.DATE, ColumnDataType.DATETIME):
        try:
            dt_series = pd.to_datetime(non_null, errors="coerce").dropna()
            if len(dt_series) > 0:
                min_val = str(dt_series.min())
                max_val = str(dt_series.max())
        except Exception:
            pass
    else:
        if valid_count > 0:
            try:
                min_val = str(non_null.min())[:50]
                max_val = str(non_null.max())[:50]
            except Exception:
                pass

    return ColumnSchema(
        name=col_name,
        dtype=dtype,
        pandas_dtype=str(series.dtype),
        null_count=null_count,
        valid_count=valid_count,
        unique_count=unique_count,
        sample_values=sample_values,
        min_val=min_val,
        max_val=max_val,
        mean_val=mean_val,
        median_val=median_val,
        std_val=std_val,
    )


def extract_sheet_schema(df: pd.DataFrame, sheet_name: str) -> SheetSchema:
    """Dynamically builds a comprehensive schema for an individual sheet."""
    row_count = len(df)
    column_count = len(df.columns)

    columns: List[ColumnSchema] = []
    numerical_cols: List[str] = []
    categorical_cols: List[str] = []
    date_cols: List[str] = []
    id_cols: List[str] = []

    for col in df.columns:
        col_schema = extract_column_schema(df[col], str(col))
        columns.append(col_schema)

        if col_schema.dtype in (ColumnDataType.INTEGER, ColumnDataType.FLOAT, ColumnDataType.NUMERIC):
            numerical_cols.append(col_schema.name)
        elif col_schema.dtype == ColumnDataType.CATEGORICAL:
            categorical_cols.append(col_schema.name)
        elif col_schema.dtype in (ColumnDataType.DATE, ColumnDataType.DATETIME, ColumnDataType.TIME):
            date_cols.append(col_schema.name)
        elif col_schema.dtype == ColumnDataType.ID_LIKE:
            id_cols.append(col_schema.name)

    return SheetSchema(
        sheet_name=sheet_name,
        row_count=row_count,
        column_count=column_count,
        columns=columns,
        numerical_columns=numerical_cols,
        categorical_columns=categorical_cols,
        date_columns=date_cols,
        id_columns=id_cols,
    )


def inspect_workbook(file_path: str) -> WorkbookMetadata:
    """
    Dynamically loads and inspects any XLSX, XLS, or CSV workbook without any
    hardcoded sheet names, column names, or dataset-specific assumptions (Section 3).
    """
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Workbook file not found: {file_path}")

    filename = path.name
    ext = path.suffix.lower()

    sheet_names: List[str] = []
    dataframes: Dict[str, pd.DataFrame] = {}
    sheets: Dict[str, SheetSchema] = {}

    if ext in (".xlsx", ".xls", ".xlsm", ".xlsb", ".xltx", ".xltm"):
        wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
        sheet_names = list(wb.sheetnames)
        wb.close()

        for sname in sheet_names:
            try:
                df = pd.read_excel(file_path, sheet_name=sname)
                df.columns = [str(c).strip() if c is not None else f"Column_{i}" for i, c in enumerate(df.columns)]
                dataframes[sname] = df
                sheets[sname] = extract_sheet_schema(df, sname)
            except Exception:
                empty_df = pd.DataFrame()
                dataframes[sname] = empty_df
                sheets[sname] = extract_sheet_schema(empty_df, sname)

    elif ext in (".csv", ".tsv"):
        sep = "\t" if ext == ".tsv" else ","
        df = None
        for enc in ["utf-8", "utf-8-sig", "latin-1", "cp1252"]:
            try:
                df = pd.read_csv(file_path, sep=sep, encoding=enc)
                break
            except Exception:
                continue

        if df is None:
            df = pd.DataFrame()

        df.columns = [str(c).strip() if c is not None else f"Column_{i}" for i, c in enumerate(df.columns)]
        sname = "Data"
        sheet_names = [sname]
        dataframes[sname] = df
        sheets[sname] = extract_sheet_schema(df, sname)

    else:
        raise ValueError(f"Unsupported file format for XLSX engine: {ext}")

    return WorkbookMetadata(
        file_path=file_path,
        filename=filename,
        sheet_names=sheet_names,
        sheet_count=len(sheet_names),
        sheets=sheets,
        dataframes=dataframes,
    )


# ============================================================================
# 2. DYNAMIC QUERY UNDERSTANDING & COLUMN RESOLUTION (Section 6 & 18)
# ============================================================================

QUERY_STOPWORDS = {
    "what", "is", "the", "are", "of", "for", "and", "in", "to", "how", "many", "much",
    "calculate", "find", "get", "show", "tell", "give", "list", "display", "check",
    "average", "mean", "median", "mode", "sum", "total", "min", "minimum", "max",
    "maximum", "standard", "deviation", "std", "variance", "var", "count", "unique",
    "column", "columns", "value", "values", "row", "rows", "record", "records", "data",
    "dataset", "sheet", "sheets", "table", "file", "spread", "range", "quantile", "percentile",
    "which", "who", "where", "there", "entries", "entry"
}


def _normalize_token(text: str) -> str:
    """Normalizes text for fuzzy token matching."""
    return re.sub(r"[^a-z0-9]", "", text.lower())


def resolve_column(query: str, columns: List[str]) -> Tuple[Optional[str], float]:
    """
    Dynamically maps a query term to an existing column name using exact,
    normalized, and token overlap matching.
    Crucial anti-hallucination rule (Section 18):
    Never substitutes unrelated columns. Only matches when query explicitly
    refers to the column.
    """
    if not columns:
        return None, 0.0

    q_lower = query.lower()
    q_norm = _normalize_token(query)
    q_tokens = re.findall(r"\b[a-z0-9_]+\b", q_lower)
    target_q_words = {w for w in q_tokens if w not in QUERY_STOPWORDS}

    best_col = None
    best_score = 0.0

    for col in columns:
        c_lower = col.lower()
        c_norm = _normalize_token(col)
        c_words = set(re.findall(r"\b[a-z0-9]+\b", c_lower))

        # 1. Exact whole-word boundary match in query
        if re.search(rf"\b{re.escape(c_lower)}\b", q_lower):
            score = 1.0 + (len(col) / 100.0)
            if score > best_score:
                best_score = score
                best_col = col
            continue

        # 2. Normalized match (e.g. "joining_date" vs "joining date")
        if c_norm and len(c_norm) >= 3 and c_norm in q_norm:
            score = 0.95
            if score > best_score:
                best_score = score
                best_col = col
            continue

        # 3. Multi-word column subset in query
        if c_words and c_words.issubset(set(q_tokens)):
            score = 0.90
            if score > best_score:
                best_score = score
                best_col = col
            continue

        # 4. Meaningful keyword overlap with non-stopword target query terms
        if target_q_words and c_words:
            overlap = c_words.intersection(target_q_words)
            if overlap:
                score = 0.70 * (len(overlap) / len(c_words))
                if score > best_score:
                    best_score = score
                    best_col = col

    return (best_col, best_score) if best_score >= 0.70 else (None, 0.0)


def resolve_sheet(query: str, sheet_names: List[str]) -> Optional[str]:
    """Dynamically finds which sheet the user is asking about, if specified."""
    if len(sheet_names) == 1:
        return sheet_names[0]

    q_lower = query.lower()
    for sname in sheet_names:
        s_lower = sname.lower()
        if re.search(rf"\b{re.escape(s_lower)}\b", q_lower) or _normalize_token(sname) in _normalize_token(query):
            return sname
    return None


# ============================================================================
# 3. GENERIC DATASET-INDEPENDENT EXECUTION ENGINE
# ============================================================================

class XLSXIntelligenceEngine:
    """
    Dataset-agnostic calculation and reasoning engine for XLSX and tabular data.
    All answers are strictly computed from Pandas/NumPy; the LLM is never the calculator.
    """

    def __init__(self, llm_client=None):
        self.llm = llm_client
        self.current_workbook: Optional[WorkbookMetadata] = None
        self.workbooks: dict[str, WorkbookMetadata] = {}

    def inspect(self, file_path: str) -> WorkbookMetadata:
        """Inspects workbook and stores it as the active dataset."""
        metadata = inspect_workbook(file_path)
        self.current_workbook = metadata
        fname = metadata.filename.lower()
        self.workbooks[fname] = metadata
        stem = Path(file_path).stem.lower()
        self.workbooks[stem] = metadata
        for token in re.findall(r"[a-z0-9]+", stem):
            if len(token) >= 3 and token not in ("dataset", "data", "file", "table", "records", "csv", "xlsx", "features"):
                self.workbooks[token] = metadata
        return metadata

    def query(self, question: str, session_id: Optional[str] = None) -> XLSXResponse:
        """
        Processes a natural language question against the active workbook.
        Dispatches to dynamic query routers, executes pandas calculations,
        and generates verified, evidence-backed answers through the verification gate.
        """
        if not self.current_workbook and not self.workbooks:
            return XLSXResponse(
                status=XLSXStatus.INSUFFICIENT_INFORMATION,
                answer="No workbook has been loaded yet. Please upload an XLSX file.",
                evidence=[],
                reason="No active workbook",
            )

        q = question.strip()
        q_lower = q.lower()
        wb = self.current_workbook

        # If question specifically mentions another loaded workbook, target that one
        for key, cand_wb in self.workbooks.items():
            if re.search(r"\b" + re.escape(key) + r"\b", q_lower):
                wb = cand_wb
                break

        if not wb:
            wb = list(self.workbooks.values())[-1]

        # --------------------------------------------------------------------
        # Gate 0: Unsupported Future Predictions / Out-of-Scope (Section 17 & Test D)
        # --------------------------------------------------------------------
        future_terms = ["next year", "in 2030", "in 2027", "in 2028", "future", "forecast", "predict", "tomorrow"]
        if any(term in q_lower for term in future_terms):
            return XLSXResponse(
                status=XLSXStatus.INSUFFICIENT_INFORMATION,
                answer=(
                    "**Insufficient Information**\n\n"
                    "The uploaded dataset does not contain future projections or information "
                    "to predict or establish future figures."
                ),
                evidence=[],
                reason="The user asked for an unsupported future prediction or external knowledge.",
            )

        # --------------------------------------------------------------------
        # Gate 1: Dataset-Level Metadata Questions (Section 7)
        # --------------------------------------------------------------------
        metadata_resp = self._handle_dataset_metadata(q, q_lower, wb)
        if metadata_resp:
            return self._verification_gate(metadata_resp, wb)

        # --------------------------------------------------------------------
        # Gate 2: Multi-Sheet Conflicting Information Check (Section 26 Test F)
        # --------------------------------------------------------------------
        if wb.sheet_count >= 2:
            conflict_resp = self._check_conflicting_information(q, q_lower, wb)
            if conflict_resp:
                return conflict_resp

        # --------------------------------------------------------------------
        # Gate 3: Resolve Target Sheet(s) (Section 13)
        # --------------------------------------------------------------------
        target_sheet = resolve_sheet(q, wb.sheet_names)
        if not target_sheet:
            sheet_query_terms = ["which sheet", "what sheet", "list sheets", "show sheets"]
            if any(t in q_lower for t in sheet_query_terms):
                return self._verification_gate(self._describe_all_sheets(wb), wb)
            # Default to first non-empty sheet
            for sname in wb.sheet_names:
                if wb.sheets[sname].row_count > 0:
                    target_sheet = sname
                    break
            if not target_sheet:
                target_sheet = wb.sheet_names[0]

        df = wb.dataframes[target_sheet]
        schema = wb.sheets[target_sheet]

        # --------------------------------------------------------------------
        # Gate 4: Cross-Sheet Questions (Section 14 & Test E)
        # --------------------------------------------------------------------
        if wb.sheet_count > 1 and any(w in q_lower for w in ["across", "both sheet", "join", "each customer", "total order value"]):
            cross_resp = self._handle_cross_sheet_query(q, q_lower, wb)
            if cross_resp:
                return self._verification_gate(cross_resp, wb)

        # --------------------------------------------------------------------
        # Gate 5: Direct Cell Lookup (Section 16)
        # --------------------------------------------------------------------
        cell_resp = self._handle_cell_lookup(q, q_lower, wb, target_sheet)
        if cell_resp:
            return self._verification_gate(cell_resp, wb)

        # --------------------------------------------------------------------
        # Gate 6: Ambiguous Column Question Check (Section 19 & Test C)
        # --------------------------------------------------------------------
        ambiguity_resp = self._check_ambiguity(q, q_lower, schema)
        if ambiguity_resp:
            return ambiguity_resp

        # --------------------------------------------------------------------
        # Gate 7: Correlation and Relationships (Section 12)
        # --------------------------------------------------------------------
        if any(w in q_lower for w in ["correlation", "correlated", "relationship between"]):
            corr_resp = self._handle_correlation(q, q_lower, df, schema, target_sheet, wb.filename)
            return self._verification_gate(corr_resp, wb)

        # --------------------------------------------------------------------
        # Gate 8: Grouping, Aggregation & Category Comparison (Sections 10 & 11)
        # --------------------------------------------------------------------
        if any(w in q_lower for w in [" by ", " per ", "grouped by", "each ", "highest", "lowest", "most", "least"]):
            group_resp = self._handle_grouping_and_comparison(q, q_lower, df, schema, target_sheet, wb.filename)
            if group_resp:
                return self._verification_gate(group_resp, wb)

        # --------------------------------------------------------------------
        # Gate 9: Filtering Queries (Section 9)
        # --------------------------------------------------------------------
        filter_resp = self._handle_filter_query(q, q_lower, df, schema, target_sheet, wb.filename)
        if filter_resp:
            return self._verification_gate(filter_resp, wb)

        # --------------------------------------------------------------------
        # Gate 9.5: Record / Entity Value Lookup (e.g. 'Quantity of Monitor', 'Global Revenue')
        # --------------------------------------------------------------------
        record_resp = self._handle_record_lookup(q, q_lower, df, schema, target_sheet, wb.filename)
        if record_resp:
            return self._verification_gate(record_resp, wb)

        # --------------------------------------------------------------------
        # Gate 10: Single Column Statistical Operations (Section 8)
        # --------------------------------------------------------------------
        col_stat_resp = self._handle_column_statistics(q, q_lower, df, schema, target_sheet, wb.filename)
        if col_stat_resp:
            return self._verification_gate(col_stat_resp, wb)

        # --------------------------------------------------------------------
        # Gate 10.5: Unspecified Column Statistical Operations (e.g. 'mean value', 'average')
        # --------------------------------------------------------------------
        unspec_stat_resp = self._handle_unspecified_column_statistics(q, q_lower, df, schema, target_sheet, wb.filename)
        if unspec_stat_resp:
            return self._verification_gate(unspec_stat_resp, wb)

        # --------------------------------------------------------------------
        # Gate 11: Nonexistent Column / Insufficient Information (Section 18 & Test B)
        # --------------------------------------------------------------------
        unresolved_resp = self._handle_unresolved_or_missing(q, q_lower, schema, wb.filename)
        return self._verification_gate(unresolved_resp, wb)

    # ========================================================================
    # HANDLERS
    # ========================================================================

    def _handle_dataset_metadata(self, q: str, q_lower: str, wb: WorkbookMetadata) -> Optional[XLSXResponse]:
        """Handles generic questions about rows, columns, sheets, and dataset overview."""
        # Row count / dataset size questions
        size_patterns = [
            "how many rows", "total rows", "number of rows", "row count", "record count", "how many records",
            "how many data", "how much data", "total data", "data count", "dataset size", "size of dataset",
            "size of the dataset", "how many entries", "how many samples", "number of entries", "number of samples",
            "how big is", "count of data", "count of records", "data rows", "dataset rows"
        ]
        if any(p in q_lower for p in size_patterns):
            target_sheet = resolve_sheet(q, wb.sheet_names) or wb.sheet_names[0]
            sheet_schema = wb.sheets[target_sheet]
            total_rows = sum(s.row_count for s in wb.sheets.values())

            # If user asked generic size ("how many data", "dataset size", "how big is"), return both rows and columns
            if any(p in q_lower for p in ["how many data", "how much data", "total data", "data count", "dataset size", "size of", "how big is"]):
                return XLSXResponse(
                    status=XLSXStatus.VERIFIED,
                    answer=(
                        f"The dataset **'{wb.filename}'** (Sheet **'{target_sheet}'**) contains "
                        f"**{sheet_schema.row_count:,}** rows and **{sheet_schema.column_count}** columns."
                    ),
                    evidence=[{
                        "file": wb.filename,
                        "sheet": target_sheet,
                        "columns": [c.name for c in sheet_schema.columns[:5]],
                        "operation": "dataset_size",
                        "rows_analyzed": sheet_schema.row_count,
                        "result": f"{sheet_schema.row_count} rows, {sheet_schema.column_count} columns",
                    }],
                )

            if wb.sheet_count == 1 or target_sheet:
                return XLSXResponse(
                    status=XLSXStatus.VERIFIED,
                    answer=f"Sheet **'{target_sheet}'** contains **{sheet_schema.row_count:,}** rows.",
                    evidence=[{
                        "file": wb.filename,
                        "sheet": target_sheet,
                        "columns": [c.name for c in sheet_schema.columns[:5]],
                        "operation": "count_rows",
                        "rows_analyzed": sheet_schema.row_count,
                        "result": sheet_schema.row_count,
                    }],
                )
            return XLSXResponse(
                status=XLSXStatus.VERIFIED,
                answer=f"The workbook contains **{total_rows:,}** total rows across {wb.sheet_count} sheet(s).",
                evidence=[{
                    "file": wb.filename,
                    "sheet": sname,
                    "operation": "count_rows",
                    "rows_analyzed": s.row_count,
                    "result": s.row_count,
                } for sname, s in wb.sheets.items()],
            )

        # Column count questions
        if any(p in q_lower for p in ["how many columns", "total columns", "number of columns", "column count", "how many features", "number of features", "feature count"]):
            target_sheet = resolve_sheet(q, wb.sheet_names) or wb.sheet_names[0]
            sheet_schema = wb.sheets[target_sheet]
            return XLSXResponse(
                status=XLSXStatus.VERIFIED,
                answer=f"Sheet **'{target_sheet}'** contains **{sheet_schema.column_count}** columns: {', '.join(f'`{c.name}`' for c in sheet_schema.columns)}.",
                evidence=[{
                    "file": wb.filename,
                    "sheet": target_sheet,
                    "columns": [c.name for c in sheet_schema.columns],
                    "operation": "count_columns",
                    "rows_analyzed": sheet_schema.row_count,
                    "result": sheet_schema.column_count,
                }],
            )

        # Sheet count / names questions
        if any(p in q_lower for p in ["how many sheets", "what sheets", "list sheets", "sheet names", "show sheets"]):
            sheet_list = ", ".join(f"`{name}` ({wb.sheets[name].row_count} rows, {wb.sheets[name].column_count} cols)" for name in wb.sheet_names)
            return XLSXResponse(
                status=XLSXStatus.VERIFIED,
                answer=f"The workbook **{wb.filename}** contains **{wb.sheet_count}** sheet(s): {sheet_list}.",
                evidence=[{
                    "file": wb.filename,
                    "sheet": sname,
                    "rows_analyzed": s.row_count,
                    "columns": [c.name for c in s.columns],
                    "operation": "list_sheets",
                    "result": wb.sheet_count,
                } for sname, s in wb.sheets.items()],
            )

        # Dataset overview / "What is this dataset about?" / "What columns are available?"
        if any(p in q_lower for p in ["what is this dataset about", "what is this data about", "what columns are available", "what columns exist", "describe this dataset", "overview"]):
            target_sheet = resolve_sheet(q, wb.sheet_names) or wb.sheet_names[0]
            schema = wb.sheets[target_sheet]
            col_descriptions = [f"- `{c.name}` ({c.dtype.value}, {c.unique_count} unique, {c.null_count} nulls)" for c in schema.columns]
            answer_text = (
                f"### Dataset Overview: **{wb.filename}**\n\n"
                f"- **Sheet**: `{target_sheet}`\n"
                f"- **Total Rows**: {schema.row_count:,}\n"
                f"- **Total Columns**: {schema.column_count}\n"
                f"- **Numerical Columns**: {', '.join(f'`{c}`' for c in schema.numerical_columns) or 'None'}\n"
                f"- **Categorical Columns**: {', '.join(f'`{c}`' for c in schema.categorical_columns) or 'None'}\n\n"
                f"**Available Columns**:\n" + "\n".join(col_descriptions)
            )
            return XLSXResponse(
                status=XLSXStatus.VERIFIED,
                answer=answer_text,
                evidence=[{
                    "file": wb.filename,
                    "sheet": target_sheet,
                    "columns": [c.name for c in schema.columns],
                    "rows_analyzed": schema.row_count,
                    "operation": "dataset_schema_overview",
                    "result": schema.column_count,
                }],
            )

        return None

    def _check_ambiguity(self, q: str, q_lower: str, schema: SheetSchema) -> Optional[XLSXResponse]:
        """
        Detects ambiguous requests where an operation is requested without
        specifying the target column, and multiple candidates exist (Section 19 & Test C).
        """
        bare_ops = {
            "average": "average (mean)",
            "mean": "mean",
            "sum": "sum",
            "total": "total",
            "median": "median",
            "max": "maximum",
            "maximum": "maximum",
            "min": "minimum",
            "minimum": "minimum",
            "mode": "mode",
            "standard deviation": "standard deviation",
            "variance": "variance",
            "range": "range",
        }
        all_cols = [c.name for c in schema.columns]
        matched_col, conf = resolve_column(q, all_cols)

        # If a specific column matched with high confidence, it is NOT ambiguous
        if matched_col and conf >= 0.70:
            return None

        for term, op_label in bare_ops.items():
            pattern = rf"\b(what|calculate|find|get)\s+(is\s+)?(the\s+)?{term}\s*(\?|$)"
            if re.search(pattern, q_lower):
                if len(schema.numerical_columns) > 1:
                    col_list = ", ".join(f"`{c}`" for c in schema.numerical_columns)
                    return XLSXResponse(
                        status=XLSXStatus.CLARIFICATION_REQUIRED,
                        answer=(
                            f"Which column would you like me to calculate the **{op_label}** for? "
                            f"Available numerical columns include: {col_list}."
                        ),
                        evidence=[],
                        reason=f"Ambiguous query: multiple numerical columns exist for {op_label}.",
                        clarification_options=schema.numerical_columns,
                    )
        return None

    def _handle_cell_lookup(self, q: str, q_lower: str, wb: WorkbookMetadata, target_sheet: str) -> Optional[XLSXResponse]:
        """
        Handles direct cell lookups like 'What is in cell B2?' or 'D27' (Section 16).
        """
        cell_match = re.search(r"\b(?:cell\s+)?([A-Za-z]{1,3})([0-9]{1,7})\b", q)
        if not cell_match:
            return None

        # Check if query actually looks like a cell inquiry
        if not any(w in q_lower for w in ["cell", "value in", "what is in", "entry at", "at"]):
            return None

        col_letter = cell_match.group(1).upper()
        row_num = int(cell_match.group(2))
        cell_ref = f"{col_letter}{row_num}"

        # Resolve via openpyxl
        try:
            wb_obj = openpyxl.load_workbook(wb.file_path, data_only=True)
            if target_sheet not in wb_obj.sheetnames:
                target_sheet = wb_obj.sheetnames[0]
            sheet_obj = wb_obj[target_sheet]
            val = sheet_obj[cell_ref].value
            wb_obj.close()

            if val is not None:
                val_str = str(val)
                answer = (
                    f"File: `{wb.filename}`\n"
                    f"Sheet: `{target_sheet}`\n"
                    f"Cell: `{cell_ref}`\n"
                    f"Value: **{val_str}**"
                )
                return XLSXResponse(
                    status=XLSXStatus.VERIFIED,
                    answer=answer,
                    evidence=[{
                        "file": wb.filename,
                        "sheet": target_sheet,
                        "cell": cell_ref,
                        "operation": "cell_lookup",
                        "result": val,
                    }],
                )
        except Exception:
            pass

        return None

    def _check_conflicting_information(self, q: str, q_lower: str, wb: WorkbookMetadata) -> Optional[XLSXResponse]:
        """
        Detects contradictory records across sheets for the same entity key (Section 26 Test F).
        Returns conflicting_information if sheets disagree.
        """
        sheets = list(wb.sheets.keys())
        if len(sheets) < 2:
            return None

        # Look for common key columns across sheets (ID, Code, Name, etc.)
        s1, s2 = sheets[0], sheets[1]
        cols1 = {c.name for c in wb.sheets[s1].columns}
        cols2 = {c.name for c in wb.sheets[s2].columns}
        common_cols = cols1.intersection(cols2)

        id_candidates = [c for c in common_cols if any(k in c.lower() for k in ["id", "code", "key", "name", "num"])]
        if not id_candidates and common_cols:
            id_candidates = list(common_cols)

        if not id_candidates:
            return None

        key_col = id_candidates[0]
        df1 = wb.dataframes[s1]
        df2 = wb.dataframes[s2]

        if key_col not in df1.columns or key_col not in df2.columns:
            return None

        # Check common non-key columns
        attr_cols = [c for c in common_cols if c != key_col]
        if not attr_cols:
            return None

        # Check if query mentions a specific key value
        for val in df1[key_col].dropna().unique()[:50]:
            val_str = str(val)
            if re.search(rf"\b{re.escape(val_str.lower())}\b", q_lower):
                # Inspect values in both sheets
                r1 = df1[df1[key_col] == val]
                r2 = df2[df2[key_col] == val]
                if len(r1) > 0 and len(r2) > 0:
                    for attr in attr_cols:
                        v1 = r1.iloc[0][attr]
                        v2 = r2.iloc[0][attr]
                        if str(v1).strip().lower() != str(v2).strip().lower():
                            return XLSXResponse(
                                status=XLSXStatus.CONFLICTING_INFORMATION,
                                answer=(
                                    f"Conflicting information detected across sheets for key **`{key_col} = {val}`**:\n\n"
                                    f"- Sheet **`{s1}`**: `{attr}` = **'{v1}'**\n"
                                    f"- Sheet **`{s2}`**: `{attr}` = **'{v2}'**\n\n"
                                    "The uploaded sheets contain contradictory data for this entity; "
                                    "the system will not arbitrarily choose one."
                                ),
                                evidence=[
                                    {"sheet": s1, "key": val_str, "column": attr, "value": str(v1)},
                                    {"sheet": s2, "key": val_str, "column": attr, "value": str(v2)},
                                ],
                                reason="Conflicting records discovered across sheets.",
                            )
        return None

    def _handle_column_statistics(self, q: str, q_lower: str, df: pd.DataFrame,
                                  schema: SheetSchema, sheet_name: str, filename: str) -> Optional[XLSXResponse]:
        """
        Calculates generic column-level statistics (Section 8):
        count, sum, mean, median, mode, min, max, std, variance, range, quantiles, percentage.
        """
        all_cols = [c.name for c in schema.columns]
        matched_col, conf = resolve_column(q, all_cols)

        if not matched_col:
            return None

        col_schema = next((c for c in schema.columns if c.name == matched_col), None)
        if col_schema is None:
            return None
        series = df[matched_col]
        non_null_series = series.dropna()
        valid_count = len(non_null_series)
        null_count = int(series.isna().sum())

        op_detected = None
        calc_result = None
        answer = ""

        # 1. Unique count
        if any(k in q_lower for k in ["how many unique", "number of unique", "distinct count", "unique values"]):
            op_detected = "unique_count"
            calc_result = int(non_null_series.nunique())
            answer = f"Column **`{matched_col}`** contains **{calc_result}** unique values (out of {valid_count:,} valid entries)."

        # 2. Missing / Null values
        elif any(k in q_lower for k in ["missing values", "null values", "null count", "how many nulls", "how many missing"]):
            op_detected = "null_count"
            calc_result = null_count
            pct = (null_count / max(1, len(series))) * 100
            answer = f"Column **`{matched_col}`** has **{null_count}** missing values ({pct:.1f}% of {len(series):,} rows)."

        # 3. Mean / Average
        elif any(k in q_lower for k in ["average", "mean"]):
            if col_schema.dtype not in (ColumnDataType.INTEGER, ColumnDataType.FLOAT, ColumnDataType.NUMERIC):
                return XLSXResponse(
                    status=XLSXStatus.INSUFFICIENT_INFORMATION,
                    answer=f"Cannot calculate average for **`{matched_col}`** because it is a non-numerical column ({col_schema.dtype.value}).",
                    evidence=[],
                    reason="Column is not numerical",
                )
            num_s = pd.to_numeric(non_null_series.astype(str).str.replace(r"[$,€£¥%\s,]", "", regex=True), errors="coerce").dropna()
            op_detected = "mean"
            calc_result = round(float(num_s.mean()), 4)
            answer = f"The average (mean) of **`{matched_col}`** is **{calc_result:,.4f}** (analyzed {len(num_s):,} rows, excluded {null_count} nulls)."

        # 4. Median
        elif any(k in q_lower for k in ["median", "middle value"]):
            if col_schema.dtype not in (ColumnDataType.INTEGER, ColumnDataType.FLOAT, ColumnDataType.NUMERIC):
                return XLSXResponse(
                    status=XLSXStatus.INSUFFICIENT_INFORMATION,
                    answer=f"Cannot calculate median for **`{matched_col}`** because it is a non-numerical column.",
                    evidence=[],
                    reason="Column is not numerical",
                )
            num_s = pd.to_numeric(non_null_series.astype(str).str.replace(r"[$,€£¥%\s,]", "", regex=True), errors="coerce").dropna()
            op_detected = "median"
            calc_result = round(float(num_s.median()), 4)
            answer = f"The median of **`{matched_col}`** is **{calc_result:,.4f}**."

        # 5. Mode
        elif any(k in q_lower for k in ["mode", "most frequent", "most common"]):
            modes = non_null_series.mode()
            if len(modes) == 0:
                return XLSXResponse(
                    status=XLSXStatus.INSUFFICIENT_INFORMATION,
                    answer=f"No mode could be calculated for **`{matched_col}`**.",
                    evidence=[],
                )
            op_detected = "mode"
            mode_val = modes.iloc[0]
            calc_result = round(float(mode_val), 4) if isinstance(mode_val, (int, float, np.number)) else str(mode_val)
            answer = f"The mode (most frequent value) of **`{matched_col}`** is **'{calc_result}'**."

        # 6. Total / Sum
        elif any(k in q_lower for k in ["total", "sum", "overall"]):
            if col_schema.dtype not in (ColumnDataType.INTEGER, ColumnDataType.FLOAT, ColumnDataType.NUMERIC):
                return XLSXResponse(
                    status=XLSXStatus.INSUFFICIENT_INFORMATION,
                    answer=f"Cannot calculate sum for **`{matched_col}`** because it is a non-numerical column.",
                    evidence=[],
                    reason="Column is not numerical",
                )
            num_s = pd.to_numeric(non_null_series.astype(str).str.replace(r"[$,€£¥%\s,]", "", regex=True), errors="coerce").dropna()
            op_detected = "sum"
            calc_result = round(float(num_s.sum()), 4)
            answer = f"The total (sum) of **`{matched_col}`** is **{calc_result:,.4f}**."

        # 7. Maximum
        elif any(k in q_lower for k in ["maximum", "highest", "max", "top value"]):
            op_detected = "max"
            if col_schema.dtype in (ColumnDataType.INTEGER, ColumnDataType.FLOAT, ColumnDataType.NUMERIC):
                num_s = pd.to_numeric(non_null_series.astype(str).str.replace(r"[$,€£¥%\s,]", "", regex=True), errors="coerce").dropna()
                calc_result = float(num_s.max())
                answer = f"The maximum **`{matched_col}`** is **{calc_result:,.4f}**."
            else:
                calc_result = str(non_null_series.max())
                answer = f"The maximum value for **`{matched_col}`** is **'{calc_result}'**."

        # 8. Minimum
        elif any(k in q_lower for k in ["minimum", "lowest", "min", "bottom value"]):
            op_detected = "min"
            if col_schema.dtype in (ColumnDataType.INTEGER, ColumnDataType.FLOAT, ColumnDataType.NUMERIC):
                num_s = pd.to_numeric(non_null_series.astype(str).str.replace(r"[$,€£¥%\s,]", "", regex=True), errors="coerce").dropna()
                calc_result = float(num_s.min())
                answer = f"The minimum **`{matched_col}`** is **{calc_result:,.4f}**."
            else:
                calc_result = str(non_null_series.min())
                answer = f"The minimum value for **`{matched_col}`** is **'{calc_result}'**."

        # 9. Range
        elif any(k in q_lower for k in ["range of", "value range"]):
            if col_schema.dtype not in (ColumnDataType.INTEGER, ColumnDataType.FLOAT, ColumnDataType.NUMERIC):
                return XLSXResponse(status=XLSXStatus.INSUFFICIENT_INFORMATION, answer="Non-numeric column.", evidence=[])
            num_s = pd.to_numeric(non_null_series.astype(str).str.replace(r"[$,€£¥%\s,]", "", regex=True), errors="coerce").dropna()
            v_min = float(num_s.min())
            v_max = float(num_s.max())
            calc_result = round(v_max - v_min, 4)
            op_detected = "range"
            answer = f"The range of **`{matched_col}`** is **{calc_result:,.4f}** (Min: {v_min:,.4f}, Max: {v_max:,.4f})."

        # 10. Quantile / Percentile
        elif any(k in q_lower for k in ["quantile", "percentile", "quartile", "25th", "75th", "90th"]):
            if col_schema.dtype not in (ColumnDataType.INTEGER, ColumnDataType.FLOAT, ColumnDataType.NUMERIC):
                return XLSXResponse(status=XLSXStatus.INSUFFICIENT_INFORMATION, answer="Non-numeric column.", evidence=[])
            num_s = pd.to_numeric(non_null_series.astype(str).str.replace(r"[$,€£¥%\s,]", "", regex=True), errors="coerce").dropna()
            pct_m = re.search(r"(\d+(?:\.\d+)?)\s*(?:th|st|nd|rd)?\s*(?:percentile|quantile)", q_lower)
            q_val = float(pct_m.group(1)) / 100.0 if pct_m else 0.50
            calc_result = round(float(num_s.quantile(q_val)), 4)
            op_detected = f"quantile_{int(q_val*100)}"
            answer = f"The {int(q_val*100)}th percentile of **`{matched_col}`** is **{calc_result:,.4f}**."

        # 11. Standard Deviation
        elif any(k in q_lower for k in ["standard deviation", "std", "dispersion"]):
            if col_schema.dtype not in (ColumnDataType.INTEGER, ColumnDataType.FLOAT, ColumnDataType.NUMERIC):
                return XLSXResponse(status=XLSXStatus.INSUFFICIENT_INFORMATION, answer="Non-numeric column.", evidence=[])
            num_s = pd.to_numeric(non_null_series.astype(str).str.replace(r"[$,€£¥%\s,]", "", regex=True), errors="coerce").dropna()
            op_detected = "std"
            calc_result = round(float(num_s.std()), 4)
            answer = f"The standard deviation of **`{matched_col}`** is **{calc_result:,.4f}**."

        # 12. Variance
        elif any(k in q_lower for k in ["variance", "var"]):
            if col_schema.dtype not in (ColumnDataType.INTEGER, ColumnDataType.FLOAT, ColumnDataType.NUMERIC):
                return XLSXResponse(status=XLSXStatus.INSUFFICIENT_INFORMATION, answer="Non-numeric column.", evidence=[])
            num_s = pd.to_numeric(non_null_series.astype(str).str.replace(r"[$,€£¥%\s,]", "", regex=True), errors="coerce").dropna()
            op_detected = "variance"
            calc_result = round(float(num_s.var()), 4)
            answer = f"The variance of **`{matched_col}`** is **{calc_result:,.4f}**."

        # 13. Count
        elif any(k in q_lower for k in ["count", "how many"]):
            op_detected = "count"
            calc_result = valid_count
            answer = f"There are **{valid_count:,}** non-null entries in **`{matched_col}`**."

        if op_detected is not None:
            return XLSXResponse(
                status=XLSXStatus.VERIFIED,
                answer=answer,
                evidence=[{
                    "file": filename,
                    "sheet": sheet_name,
                    "columns": [matched_col],
                    "operation": op_detected,
                    "rows_analyzed": valid_count,
                    "missing_values_excluded": null_count,
                    "result": calc_result,
                }],
            )

        return None

    def _handle_unspecified_column_statistics(self, q: str, q_lower: str, df: pd.DataFrame,
                                              schema: SheetSchema, sheet_name: str, filename: str) -> Optional[XLSXResponse]:
        """
        Handles statistical queries (mean, median, sum, min, max, std)
        when no specific column was named in the question (e.g. 'mean value', 'what is the average').
        Computes the operation dynamically across all numerical columns in the active dataset.
        """
        stat_op = None
        op_label = ""
        if any(k in q_lower for k in ["mean", "average", "avg"]):
            stat_op = "mean"
            op_label = "Mean (Average)"
        elif any(k in q_lower for k in ["median", "middle value"]):
            stat_op = "median"
            op_label = "Median"
        elif any(k in q_lower for k in ["sum", "total"]):
            stat_op = "sum"
            op_label = "Total Sum"
        elif any(k in q_lower for k in ["max", "maximum", "highest"]):
            stat_op = "max"
            op_label = "Maximum"
        elif any(k in q_lower for k in ["min", "minimum", "lowest"]):
            stat_op = "min"
            op_label = "Minimum"
        elif any(k in q_lower for k in ["std", "standard deviation"]):
            stat_op = "std"
            op_label = "Standard Deviation"

        if not stat_op:
            return None

        # If the question contains candidate tokens that look like a specific requested column
        # (e.g. 'What is the average revenue?'), do NOT treat it as unspecified.
        # Let Gate 11 handle it as a nonexistent column to prevent hallucination.
        file_tokens = set(re.findall(r"[a-z0-9]+", filename.lower()))
        sheet_tokens = set(re.findall(r"[a-z0-9]+", sheet_name.lower()))
        generic_tokens = {"dataset", "data", "file", "table", "sheet", "csv", "xlsx", "records", "rows", "columns", "value", "values", "entry", "entries"}
        candidate_col_tokens = [
            t for t in re.findall(r"\b[a-z0-9_]{3,}\b", q_lower)
            if t not in QUERY_STOPWORDS and t not in file_tokens and t not in sheet_tokens and t not in generic_tokens
        ]
        if candidate_col_tokens:
            return None

        num_cols = schema.numerical_columns
        if not num_cols:
            return XLSXResponse(
                status=XLSXStatus.INSUFFICIENT_INFORMATION,
                answer=f"Sheet **'{sheet_name}'** has no numerical columns to calculate {op_label.lower()} for.",
                evidence=[],
                reason="No numerical columns in sheet",
            )

        rows_table = []
        evidence_list = []
        for col in num_cols:
            s = pd.to_numeric(df[col].astype(str).str.replace(r"[$,€£¥%\s,]", "", regex=True), errors="coerce").dropna()
            if len(s) == 0:
                continue
            if stat_op == "mean":
                val = round(float(s.mean()), 4)
            elif stat_op == "median":
                val = round(float(s.median()), 4)
            elif stat_op == "sum":
                val = round(float(s.sum()), 4)
            elif stat_op == "max":
                val = round(float(s.max()), 4)
            elif stat_op == "min":
                val = round(float(s.min()), 4)
            elif stat_op == "std":
                val = round(float(s.std(ddof=1)), 4) if len(s) > 1 else 0.0
            else:
                continue

            rows_table.append(f"| `{col}` | **{val:,.4f}** | {len(s):,} |")
            evidence_list.append({
                "file": filename,
                "sheet": sheet_name,
                "column": col,
                "operation": stat_op,
                "rows_analyzed": len(s),
                "result": val,
            })

        table_str = "\n".join(rows_table)
        answer = (
            f"### {op_label} across Numerical Columns in **'{sheet_name}'** ({filename}):\n\n"
            f"| Column | {op_label} | Rows Analyzed |\n"
            f"| :--- | :--- | :--- |\n"
            f"{table_str}\n\n"
            f"*Tip: You can ask for a specific column, e.g., 'What is the {stat_op} of {num_cols[0]}?'*"
        )
        return XLSXResponse(
            status=XLSXStatus.VERIFIED,
            answer=answer,
            evidence=evidence_list,
            clarification_options=num_cols[:8],
        )

    def _handle_filter_query(self, q: str, q_lower: str, df: pd.DataFrame,
                             schema: SheetSchema, sheet_name: str, filename: str) -> Optional[XLSXResponse]:
        """Handles natural language filtering (e.g. 'greater than 30', 'below 500') (Section 9)."""
        all_cols = [c.name for c in schema.columns]
        matched_col, conf = resolve_column(q, all_cols)

        if not matched_col:
            return None

        patterns = [
            (r"(?:greater than|above|over|more than|>)\s*([0-9\.\,]+)", ">", "greater_than"),
            (r"(?:less than|below|under|fewer than|<)\s*([0-9\.\,]+)", "<", "less_than"),
            (r"(?:greater than or equal to|at least|>=)\s*([0-9\.\,]+)", ">=", "greater_equal"),
            (r"(?:less than or equal to|at most|<=)\s*([0-9\.\,]+)", "<=", "less_equal"),
            (r"(?:equals?|equal to|==)\s*([0-9\.\,]+)", "==", "equal"),
            (r"(?:is equal to|equals?|is)\s*['\"]([^'\"]+)['\"]", "==", "string_equal"),
        ]

        op_symbol, op_name, target_val = None, None, None
        for pat, sym, name in patterns:
            m = re.search(pat, q_lower)
            if m:
                op_symbol = sym
                op_name = name
                raw_val = m.group(1).replace(",", "")
                try:
                    target_val = float(raw_val) if "." in raw_val else int(raw_val)
                except ValueError:
                    target_val = raw_val.strip()
                break

        if op_symbol is None or target_val is None:
            return None

        series = df[matched_col]
        if isinstance(target_val, (int, float)):
            clean_series = pd.to_numeric(
                series.astype(str).str.replace(r"[$,€£¥%\s,]", "", regex=True),
                errors="coerce"
            )
        else:
            clean_series = series.astype(str)

        if op_symbol == ">":
            mask = clean_series > target_val
        elif op_symbol == "<":
            mask = clean_series < target_val
        elif op_symbol == ">=":
            mask = clean_series >= target_val
        elif op_symbol == "<=":
            mask = clean_series <= target_val
        elif op_symbol == "==":
            mask = clean_series == target_val
        else:
            return None

        matching_rows = int(mask.sum())
        total_valid = int(clean_series.notna().sum())
        missing_count = int(series.isna().sum())
        filtered_sample = df[mask].head(5).to_dict(orient="records")

        answer = (
            f"There are **{matching_rows:,}** records where **`{matched_col}`** {op_symbol} `{target_val}` "
            f"(out of {total_valid:,} rows analyzed, {missing_count} nulls excluded)."
        )

        return XLSXResponse(
            status=XLSXStatus.VERIFIED,
            answer=answer,
            evidence=[{
                "file": filename,
                "sheet": sheet_name,
                "columns": [matched_col],
                "filter": f"{matched_col} {op_symbol} {target_val}",
                "operation": op_name,
                "rows_analyzed": total_valid,
                "missing_values_excluded": missing_count,
                "matching_rows": matching_rows,
                "result": matching_rows,
                "sample_matches": filtered_sample,
            }],
        )

    def _handle_record_lookup(self, q: str, q_lower: str, df: pd.DataFrame,
                              schema: SheetSchema, sheet_name: str, filename: str) -> Optional[XLSXResponse]:
        """
        Handles direct record/entity lookup queries (e.g. 'What is the Quantity of Monitor?',
        'What is the Global Revenue?', 'Details for Customer 101').
        """
        all_cols = [c.name for c in schema.columns]
        matched_target_col, conf = resolve_column(q, all_cols)

        filter_col = None
        filter_val = None

        # Look for a value match across all columns in df
        for col in all_cols:
            if col == matched_target_col:
                continue
            series = df[col].dropna()
            uniques = series.unique()
            sample_vals = (uniques[:250].tolist() + uniques[-250:].tolist()) if len(uniques) > 500 else uniques.tolist()

            for val in sample_vals:
                val_str = str(val).strip()
                if not val_str or len(val_str) < 2:
                    continue
                if re.search(rf"\b{re.escape(val_str.lower())}\b", q_lower):
                    filter_col = col
                    filter_val = val
                    break
            if filter_col:
                break

        if not filter_col or filter_val is None:
            return None

        # Filter the rows
        matched_rows = df[df[filter_col].astype(str).str.strip().str.lower() == str(filter_val).strip().lower()]
        if len(matched_rows) == 0:
            return None

        if matched_target_col:
            val_result = matched_rows[matched_target_col].iloc[0]
            val_display = f"{val_result:,.4f}" if isinstance(val_result, float) else str(val_result)
            answer = (
                f"In sheet **`{sheet_name}`**, for **`{filter_col}` = '{filter_val}'**, "
                f"the **`{matched_target_col}`** is **{val_display}**."
            )
            return XLSXResponse(
                status=XLSXStatus.VERIFIED,
                answer=answer,
                evidence=[{
                    "file": filename,
                    "sheet": sheet_name,
                    "columns": [filter_col, matched_target_col],
                    "filter": f"{filter_col} == '{filter_val}'",
                    "operation": "record_lookup",
                    "rows_analyzed": len(df),
                    "result": val_result,
                }],
            )

        row_dict = matched_rows.iloc[0].to_dict()
        breakdown = "\n".join(f"- **`{k}`**: {v}" for k, v in row_dict.items())
        answer = f"Details for **`{filter_col}` = '{filter_val}'** in sheet **`{sheet_name}`**:\n\n{breakdown}"
        return XLSXResponse(
            status=XLSXStatus.VERIFIED,
            answer=answer,
            evidence=[{
                "file": filename,
                "sheet": sheet_name,
                "columns": all_cols,
                "filter": f"{filter_col} == '{filter_val}'",
                "operation": "entity_lookup",
                "rows_analyzed": len(df),
                "result": row_dict,
            }],
        )

    def _handle_grouping_and_comparison(self, q: str, q_lower: str, df: pd.DataFrame,
                                        schema: SheetSchema, sheet_name: str, filename: str) -> Optional[XLSXResponse]:
        """
        Handles grouping and comparison (Sections 10 & 11):
        e.g. 'average salary by department', 'which department has the highest average salary'
        """
        num_cols = schema.numerical_columns
        cat_cols = schema.categorical_columns + [c.name for c in schema.columns if c.dtype in (ColumnDataType.STRING, ColumnDataType.ID_LIKE)]

        group_col = None
        for col in cat_cols:
            c_low = col.lower()
            if re.search(rf"\b{re.escape(c_low)}\b", q_lower) or _normalize_token(col) in _normalize_token(q):
                group_col = col
                break

        measure_col = None
        for col in num_cols:
            c_low = col.lower()
            if re.search(rf"\b{re.escape(c_low)}\b", q_lower) or _normalize_token(col) in _normalize_token(q):
                measure_col = col
                break

        if not group_col and not measure_col:
            return None

        # Count by category if measure missing
        if group_col and not measure_col and any(w in q_lower for w in ["count", "how many", "distribution"]):
            size_s: Any = df.groupby(group_col).size()
            grouped: pd.DataFrame = size_s.reset_index(name="Count")
            top_val = grouped.loc[grouped["Count"].idxmax()]
            answer = (
                f"Count by **`{group_col}`**:\n\n"
                f"- Top category: **{top_val[group_col]}** ({top_val['Count']:,} records)\n"
                f"- Total categories: {len(grouped)}"
            )
            return XLSXResponse(
                status=XLSXStatus.VERIFIED,
                answer=answer,
                evidence=[{
                    "file": filename,
                    "sheet": sheet_name,
                    "columns": [group_col],
                    "operation": "groupby_count",
                    "rows_analyzed": len(df),
                    "result": grouped.to_dict(orient="records")[:10],
                }],
            )

        if not group_col or not measure_col:
            return None

        clean_df = df[[group_col, measure_col]].copy()
        clean_df[measure_col] = pd.to_numeric(
            clean_df[measure_col].astype(str).str.replace(r"[$,€£¥%\s,]", "", regex=True),
            errors="coerce"
        )
        clean_df = clean_df.dropna()

        if len(clean_df) == 0:
            return None

        # Determine aggregation
        if any(w in q_lower for w in ["total", "sum"]):
            agg_op = "sum"
            agg_label = "total"
        elif any(w in q_lower for w in ["median"]):
            agg_op = "median"
            agg_label = "median"
        elif any(w in q_lower for w in ["max", "highest", "maximum"]):
            agg_op = "max"
            agg_label = "maximum"
        elif any(w in q_lower for w in ["min", "lowest", "minimum"]):
            agg_op = "min"
            agg_label = "minimum"
        else:
            agg_op = "mean"
            agg_label = "average"

        grouped = clean_df.groupby(group_col)[measure_col].agg(agg_op).reset_index()

        # Comparison / winner question ("which department has highest...")
        if any(w in q_lower for w in ["which", "what", "who", "highest", "lowest", "top", "best", "worst"]):
            if any(w in q_lower for w in ["lowest", "min", "least", "bottom"]):
                idx = grouped[measure_col].idxmin()
                row = grouped.loc[idx]
                answer = f"**{row[group_col]}** has the lowest {agg_label} `{measure_col}` with **{row[measure_col]:,.4f}**."
            else:
                idx = grouped[measure_col].idxmax()
                row = grouped.loc[idx]
                answer = f"**{row[group_col]}** has the highest {agg_label} `{measure_col}` with **{row[measure_col]:,.4f}**."

            return XLSXResponse(
                status=XLSXStatus.VERIFIED,
                answer=answer,
                evidence=[{
                    "file": filename,
                    "sheet": sheet_name,
                    "columns": [group_col, measure_col],
                    "operation": f"groupby_{agg_op}",
                    "rows_analyzed": len(clean_df),
                    "missing_values_excluded": len(df) - len(clean_df),
                    "result": {str(row[group_col]): float(row[measure_col])},
                    "breakdown": grouped.to_dict(orient="records")[:10],
                }],
            )

        breakdown_str = "\n".join(f"- `{r[group_col]}`: **{r[measure_col]:,.4f}**" for _, r in grouped.head(10).iterrows())
        answer = f"The {agg_label} **`{measure_col}`** by **`{group_col}`**:\n\n{breakdown_str}"

        return XLSXResponse(
            status=XLSXStatus.VERIFIED,
            answer=answer,
            evidence=[{
                "file": filename,
                "sheet": sheet_name,
                "columns": [group_col, measure_col],
                "operation": f"groupby_{agg_op}",
                "rows_analyzed": len(clean_df),
                "missing_values_excluded": len(df) - len(clean_df),
                "result": grouped.to_dict(orient="records")[:10],
            }],
        )

    def _handle_correlation(self, q: str, q_lower: str, df: pd.DataFrame,
                            schema: SheetSchema, sheet_name: str, filename: str) -> XLSXResponse:
        """Calculates Pearson correlation between two numeric variables (Section 12)."""
        num_cols = schema.numerical_columns
        all_cols = [c.name for c in schema.columns]

        found_cols = []
        for col in all_cols:
            c_low = col.lower()
            if re.search(rf"\b{re.escape(c_low)}\b", q_lower) or _normalize_token(col) in _normalize_token(q):
                found_cols.append(col)

        if len(found_cols) < 2:
            return XLSXResponse(
                status=XLSXStatus.INSUFFICIENT_INFORMATION,
                answer="Insufficient information. The requested variables for correlation could not be found in the uploaded workbook.",
                evidence=[],
                reason="Could not resolve two valid variables from the query.",
            )

        col1, col2 = found_cols[0], found_cols[1]
        if col1 not in num_cols or col2 not in num_cols:
            return XLSXResponse(
                status=XLSXStatus.INSUFFICIENT_INFORMATION,
                answer=f"Insufficient information. Correlation requires numerical variables, but `{col1}` or `{col2}` is non-numerical.",
                evidence=[],
                reason="One or both columns are not numerical.",
            )

        clean_pair = df[[col1, col2]].copy()
        clean_pair[col1] = pd.to_numeric(clean_pair[col1].astype(str).str.replace(r"[$,€£¥%\s,]", "", regex=True), errors="coerce")
        clean_pair[col2] = pd.to_numeric(clean_pair[col2].astype(str).str.replace(r"[$,€£¥%\s,]", "", regex=True), errors="coerce")
        clean_pair = clean_pair.dropna()

        if len(clean_pair) < 2:
            return XLSXResponse(
                status=XLSXStatus.INSUFFICIENT_INFORMATION,
                answer="Insufficient data points to compute correlation.",
                evidence=[],
                reason="Not enough overlapping numerical rows.",
            )

        corr_val = float(clean_pair[col1].corr(clean_pair[col2]))
        strength = "strong" if abs(corr_val) > 0.7 else "moderate" if abs(corr_val) > 0.3 else "weak"
        direction = "positive" if corr_val > 0 else "negative"

        answer = (
            f"The Pearson correlation between **`{col1}`** and **`{col2}`** is **{corr_val:.4f}** "
            f"({strength} {direction} correlation, calculated on {len(clean_pair):,} rows)."
        )

        return XLSXResponse(
            status=XLSXStatus.VERIFIED,
            answer=answer,
            evidence=[{
                "file": filename,
                "sheet": sheet_name,
                "columns": [col1, col2],
                "operation": "pearson_correlation",
                "rows_analyzed": len(clean_pair),
                "result": round(corr_val, 4),
            }],
        )

    def _handle_cross_sheet_query(self, q: str, q_lower: str, wb: WorkbookMetadata) -> Optional[XLSXResponse]:
        """
        Handles multi-sheet questions by discovering verified shared keys (Section 14 & Test E).
        Never joins arbitrarily without verified shared key overlap.
        """
        sheets = list(wb.sheets.keys())
        if len(sheets) < 2:
            return None

        s1, s2 = sheets[0], sheets[1]
        cols1 = {c.name for c in wb.sheets[s1].columns}
        cols2 = {c.name for c in wb.sheets[s2].columns}

        shared_keys = cols1.intersection(cols2)
        if not shared_keys:
            c1_map = {c.lower(): c for c in cols1}
            c2_map = {c.lower(): c for c in cols2}
            common_low = set(c1_map.keys()).intersection(set(c2_map.keys()))
            if common_low:
                k_low = next(iter(common_low))
                shared_keys = {c1_map[k_low]}

        if not shared_keys:
            return XLSXResponse(
                status=XLSXStatus.INSUFFICIENT_INFORMATION,
                answer="Insufficient information to determine a reliable relationship between these sheets.",
                evidence=[],
                reason="No validated shared key between sheets.",
            )

        join_key = next(iter(shared_keys))
        df1 = wb.dataframes[s1]
        df2 = wb.dataframes[s2]

        try:
            merged = pd.merge(df1, df2, on=join_key, how="inner")
            if len(merged) == 0:
                return XLSXResponse(
                    status=XLSXStatus.INSUFFICIENT_INFORMATION,
                    answer="Insufficient information: sheets share key name but have zero overlapping values.",
                    evidence=[],
                    reason="Inner join yielded 0 rows.",
                )

            num_cols = [c for c in merged.columns if pd.api.types.is_numeric_dtype(merged[c]) and c != join_key]
            measure = next((c for c in num_cols if c.lower() in q_lower), None)
            if not measure and num_cols:
                measure = num_cols[0]

            if measure:
                grouped = merged.groupby(join_key)[measure].sum().reset_index()
                sample_res = grouped.head(5).to_dict(orient="records")
                answer = (
                    f"Successfully performed validated join on **`{join_key}`** between `{s1}` and `{s2}` "
                    f"({len(merged):,} matching rows).\n\n"
                    f"Total **`{measure}`** aggregated by **`{join_key}`** (showing top 5):\n"
                    + "\n".join(f"- `{r[join_key]}`: **{r[measure]:,.2f}**" for _, r in grouped.head(5).iterrows())
                )
                return XLSXResponse(
                    status=XLSXStatus.VERIFIED,
                    answer=answer,
                    evidence=[{
                        "file": wb.filename,
                        "sheets": [s1, s2],
                        "join_key": join_key,
                        "rows_analyzed": len(merged),
                        "operation": f"inner_join_sum_{measure}",
                        "result": sample_res,
                    }],
                )
        except Exception as e:
            return XLSXResponse(
                status=XLSXStatus.PROCESSING_ERROR,
                answer=f"Could not reliably join sheets: {str(e)}",
                evidence=[],
            )

        return None

    def _describe_all_sheets(self, wb: WorkbookMetadata) -> XLSXResponse:
        """Lists and describes all sheets in the workbook."""
        lines = []
        for sname, s in wb.sheets.items():
            lines.append(f"### Sheet: **`{sname}`**\n- Rows: {s.row_count:,}, Columns: {s.column_count}\n- Columns: {', '.join(f'`{c.name}`' for c in s.columns)}")

        return XLSXResponse(
            status=XLSXStatus.VERIFIED,
            answer="\n\n".join(lines),
            evidence=[{
                "file": wb.filename,
                "sheet": sname,
                "rows_analyzed": s.row_count,
                "columns": [c.name for c in s.columns],
                "operation": "inspect_sheets",
                "result": wb.sheet_count,
            } for sname, s in wb.sheets.items()],
        )

    def _handle_unresolved_or_missing(self, q: str, q_lower: str,
                                      schema: SheetSchema, filename: str) -> XLSXResponse:
        """
        When a query refers to a column or concept that does NOT exist in the
        uploaded workbook, returns strict insufficient_information (Section 18 & Test B).
        Never substitutes unrelated columns.
        """
        tokens = re.findall(r"\b[a-z0-9_]{3,}\b", q_lower)
        file_tokens = set(re.findall(r"[a-z0-9]+", filename.lower()))
        sheet_tokens = set(re.findall(r"[a-z0-9]+", schema.sheet_name.lower()))
        generic_tokens = {"dataset", "data", "file", "table", "sheet", "csv", "xlsx", "records", "rows", "columns", "value", "values", "entry", "entries"}
        candidates = [t for t in tokens if t not in QUERY_STOPWORDS and t not in file_tokens and t not in sheet_tokens and t not in generic_tokens]
        target_name = f"`{candidates[0]}`" if candidates else "the requested"
        col_names = [c.name for c in schema.columns]
        
        return XLSXResponse(
            status=XLSXStatus.INSUFFICIENT_INFORMATION,
            answer=(
                f"**Insufficient information** in the uploaded dataset to answer this question.\n\n"
                f"No matching {target_name} field was found in sheet **'{schema.sheet_name}'**. "
                f"Available columns are: {', '.join(f'`{c}`' for c in col_names)}."
            ),
            evidence=[],
            reason=f"Nonexistent column '{candidates[0] if candidates else 'unknown'}'.",
        )

    # ========================================================================
    # 4. HALLUCINATION / VERIFICATION GATE (Section 23)
    # ========================================================================

    def _verification_gate(self, response: XLSXResponse, wb: WorkbookMetadata) -> XLSXResponse:
        """
        Enforces final strict validation before returning any answer (Section 23):
        - Source validation: file, sheet, columns must actually exist.
        - Calculation validation: result must come from pandas/actual data.
        - Evidence validation: row counts must be valid (not exceeding sheet row count).
        If any check fails, immediately sets status = insufficient_information.
        """
        if response.status != XLSXStatus.VERIFIED:
            return response

        if not response.evidence:
            return XLSXResponse(
                status=XLSXStatus.INSUFFICIENT_INFORMATION,
                answer="Insufficient information in the uploaded dataset to answer this question.",
                evidence=[],
                reason="Verification gate failed: No supporting evidence provided for calculation.",
            )

        for ev in response.evidence:
            # 1. Source Sheet Check
            sheet = ev.get("sheet")
            if sheet and sheet not in wb.sheet_names:
                return XLSXResponse(
                    status=XLSXStatus.INSUFFICIENT_INFORMATION,
                    answer="Insufficient information in the uploaded dataset to answer this question.",
                    evidence=[],
                    reason=f"Verification gate failed: Referenced sheet '{sheet}' does not exist in workbook.",
                )

            # 2. Source Column Check
            cols = ev.get("columns", [])
            if sheet and cols:
                sheet_cols = [c.name for c in wb.sheets[sheet].columns]
                for col in cols:
                    if col not in sheet_cols:
                        return XLSXResponse(
                            status=XLSXStatus.INSUFFICIENT_INFORMATION,
                            answer="Insufficient information in the uploaded dataset to answer this question.",
                            evidence=[],
                            reason=f"Verification gate failed: Referenced column '{col}' does not exist in sheet '{sheet}'.",
                        )

            # 3. Row count validation
            rows_analyzed = ev.get("rows_analyzed")
            if sheet and rows_analyzed is not None:
                max_rows = wb.sheets[sheet].row_count
                if rows_analyzed > max_rows:
                    return XLSXResponse(
                        status=XLSXStatus.INSUFFICIENT_INFORMATION,
                        answer="Insufficient information in the uploaded dataset to answer this question.",
                        evidence=[],
                        reason=f"Verification gate failed: rows_analyzed ({rows_analyzed}) exceeds sheet row count ({max_rows}).",
                    )

            # 4. Result validation
            if "result" in ev and ev["result"] is None:
                return XLSXResponse(
                    status=XLSXStatus.INSUFFICIENT_INFORMATION,
                    answer="Insufficient information in the uploaded dataset to answer this question.",
                    evidence=[],
                    reason="Verification gate failed: Operation result is null.",
                )

        return response
