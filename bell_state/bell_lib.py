"""Clean Bell-state implementation for tests and scripts.

This module contains the core functions (build_bell_circuit, get_statevector,
run_qasm) implemented cleanly so tests can import reliably even if other
files are corrupted.
"""
from qiskit import QuantumCircuit, transpile
try:
    from qiskit_aer import AerSimulator
except Exception:
    from qiskit.providers.aer import AerSimulator
from qiskit.quantum_info import Statevector


def build_bell_circuit(include_measure: bool = True) -> QuantumCircuit:
    if include_measure:
        qc = QuantumCircuit(2, 2)
        qc.h(0)
        qc.cx(0, 1)
        qc.barrier()
        qc.measure([0, 1], [0, 1])
    else:
        qc = QuantumCircuit(2)
        qc.h(0)
        qc.cx(0, 1)
    return qc


def get_statevector() -> Statevector:
    qc = build_bell_circuit(include_measure=False)
    return Statevector.from_instruction(qc)


def run_qasm(qc: QuantumCircuit, shots: int = 1024):
    backend = AerSimulator()
    tqc = transpile(qc, backend=backend)
    job = backend.run(tqc, shots=shots)
    result = job.result()
    return result.get_counts()
