"""
Energy Bill Calculator — simple GUI app.
Uses the calculation logic from calculator.py.
"""

import tkinter as tk
from tkinter import ttk, messagebox


def calculate_bill(daily_usage: float, rate: float, days: int) -> tuple[float, float]:
    """Compute total energy (kWh) and total bill ($)."""
    total_energy = daily_usage * days
    total_bill = total_energy * rate / 100
    return total_energy, total_bill


def main():
    root = tk.Tk()
    root.title("Energy Bill Calculator")
    root.resizable(True, True)
    root.minsize(320, 260)

    # Main frame with padding
    main = ttk.Frame(root, padding=20)
    main.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
    root.columnconfigure(0, weight=1)
    root.rowconfigure(0, weight=1)

    # Inputs
    ttk.Label(main, text="Daily energy usage (kWh):").grid(row=0, column=0, sticky=tk.W, pady=(0, 4))
    daily_var = tk.StringVar(value="")
    daily_entry = ttk.Entry(main, textvariable=daily_var, width=20)
    daily_entry.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=(0, 12))

    ttk.Label(main, text="Electricity rate (cents per kWh):").grid(row=2, column=0, sticky=tk.W, pady=(0, 4))
    rate_var = tk.StringVar(value="")
    rate_entry = ttk.Entry(main, textvariable=rate_var, width=20)
    rate_entry.grid(row=3, column=0, sticky=(tk.W, tk.E), pady=(0, 12))

    ttk.Label(main, text="Days in billing cycle:").grid(row=4, column=0, sticky=tk.W, pady=(0, 4))
    days_var = tk.StringVar(value="30")
    days_entry = ttk.Entry(main, textvariable=days_var, width=20)
    days_entry.grid(row=5, column=0, sticky=(tk.W, tk.E), pady=(0, 16))

    main.columnconfigure(0, weight=1)

    # Results area
    result_frame = ttk.LabelFrame(main, text="Bill summary", padding=10)
    result_frame.grid(row=6, column=0, sticky=(tk.W, tk.E), pady=(0, 12))
    result_frame.columnconfigure(0, weight=1)

    result_text = tk.Text(result_frame, height=6, width=40, state=tk.DISABLED, wrap=tk.WORD)
    result_text.grid(row=0, column=0, sticky=(tk.W, tk.E))

    def do_calculate():
        try:
            daily = float(daily_var.get().strip())
            rate = float(rate_var.get().strip())
            days = int(days_var.get().strip())
        except ValueError:
            messagebox.showerror("Invalid input", "Please enter valid numbers for all fields.")
            return
        if daily < 0 or rate < 0 or days < 1:
            messagebox.showerror("Invalid input", "Values must be positive; days must be at least 1.")
            return

        total_energy, total_bill = calculate_bill(daily, rate, days)
        summary = (
            f"Daily usage: {daily} kWh\n"
            f"Rate: {rate} cents per kWh\n"
            f"Days: {days}\n"
            f"Total energy used: {total_energy:.1f} kWh\n"
            f"Total bill: ${total_bill:.2f}"
        )
        result_text.config(state=tk.NORMAL)
        result_text.delete("1.0", tk.END)
        result_text.insert(tk.END, summary)
        result_text.config(state=tk.DISABLED)

    ttk.Button(main, text="Calculate", command=do_calculate).grid(row=7, column=0, pady=(0, 8))

    root.mainloop()


if __name__ == "__main__":
    main()
