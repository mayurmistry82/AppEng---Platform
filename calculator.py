# Energy Bill Calculator
# This program calculates a customer's energy bill

#Get inputs from user
daily_usage = float(input("Enter your daily energy usage in kWh: "))
rate = float(input("Enter your electricity rate in cents per kWh: "))
days = int(input("Enter the number of days in your billing cycle: "))

#Calculate total energy used and total bill amount
total_energy = daily_usage * days
total_bill = total_energy * rate / 100

#Display the results
print("--- Energy Bill Summary ---")
print(f"Daily usage: {daily_usage} kWh")
print(f"Rate: {rate} cents per kWh")
print(f"Days: {days}")  
print(f"Total energy used: {total_energy} kWh")
print(f"Total bill: ${total_bill:.2f}")