# Bell State (Qiskit)

This small example builds and simulates a Bell state (|Φ+> = (|00> + |11>)/√2) using Qiskit.

Files
- `bell.py` - builds the circuit, runs a statevector simulator and a qasm simulator (shots), and prints results.
- `requirements.txt` - minimal dependencies (qiskit)
- `test_bell.py` - basic pytest test verifying the output distribution and statevector.

How to run

Install dependencies (preferably inside a virtualenv):

```powershell
python -m pip install -r requirements.txt
```

Run the script:

```powershell
python bell.py
```

Run tests:

```powershell
python -m pytest -q
```
