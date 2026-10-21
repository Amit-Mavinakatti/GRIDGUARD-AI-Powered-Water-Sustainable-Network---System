from pathlib import Path
import pandas as pd

PROJECT_DIR = Path(__file__).resolve().parent
DATA_DIR = PROJECT_DIR / "data"


def list_sensor_datasets():
    """Return the CSV datasets bundled with GRIDGUARD."""
    datasets = []

    for path in sorted(DATA_DIR.glob("*.csv")):
        if path.name.startswith("LeakDB_"):
            title = "LeakDB Scenario 6 labels"
            description = "Timestamped leak/no-leak labels from LeakDB."
        else:
            title = "Sample sensor readings"
            description = "Small example pressure and flow readings."

        datasets.append({
            "filename": path.name,
            "title": title,
            "description": description,
            "size_bytes": path.stat().st_size,
        })

    return datasets


def load_sensor_dataset(filename):
    """Load and inspect a CSV sensor dataset."""

    # Only allow CSV files inside the project's data folder.
    data_dir = DATA_DIR.resolve()
    path = (data_dir / filename).resolve()

    if path.parent != data_dir:
        raise ValueError("Dataset must be inside the data folder.")

    if not path.is_file() or path.suffix.lower() != ".csv":
        raise FileNotFoundError("CSV dataset not found in data folder.")

    data = pd.read_csv(path)

    if data.empty:
        raise ValueError("Dataset is empty.")

    data.columns = [str(column).strip() for column in data.columns]

    if path.name.startswith("LeakDB_"):
        description = "Timestamped leak/no-leak labels from LeakDB Scenario 6."
    else:
        description = "Sample pressure and flow readings for GRIDGUARD."

    return {
        "filename": path.name,
        "description": description,
        "rows": len(data),
        "columns": data.columns.tolist(),
        "preview": data.head(10).astype(object)
            .where(pd.notna(data.head(10)), None)
            .to_dict(orient="records")
    }
