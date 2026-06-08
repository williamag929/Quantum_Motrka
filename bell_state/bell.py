"""Create and simulate a Bell state using Qiskit.

This script is a simple example that uses the `bell_lib` library to build
the |Φ+> Bell state, print the statevector, and run a sampling simulation.
"""
from bell_lib import build_bell_circuit, get_statevector, run_qasm


def main() -> None:
    """Builds and simulates a Bell state, printing the results."""
    qc = build_bell_circuit(include_measure=True)
    print("Circuit:\n", qc)

    sv = get_statevector()
    print("Statevector:\n", sv)

    counts = run_qasm(qc)
    print("Counts:\n", counts)


if __name__ == "__main__":
    main()
