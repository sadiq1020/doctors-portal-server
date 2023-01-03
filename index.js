const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const nodemailer = require("nodemailer");
const mg = require('nodemailer-mailgun-transport');
const jwt = require('jsonwebtoken');
require('dotenv').config(); // Module 74-2
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const port = process.env.PORT || 5000;

const app = express();

// middleware -------
app.use(cors());
app.use(express.json());
// ------------------



const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.e3n1sso.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

// send booking email function [Module 78.5-1]
function sendBookingEmail(booking) {
    const { email, treatment, appointmentDate, slot } = booking;

    const auth = {
        auth: {
            api_key: process.env.EMAIL_SEND_KEY,
            domain: process.env.EMAIL_SEND_DOMAIN
        }
    }

    const transporter = nodemailer.createTransport(mg(auth));


    /* let transporter = nodemailer.createTransport({
        host: 'smtp.sendgrid.net',
        port: 587,
        auth: {
            user: "apikey",
            pass: process.env.SENDGRID_API_KEY // ekhane sendgrid theke api key pathao lagto
        }
    }); */

    transporter.sendMail({
        from: "sajidnsubd@gmail.com", // verified sender email (send grid shala)
        to: email, // recipient email
        subject: `Your appointment for ${treatment} is confirmed`, // Subject line
        text: 'Hello', // plain text body
        html: `
        <h3> Your appointment is confirmed<h3>
        <div>
            <p>Your appointment for ${treatment}</p>
            <p>Place visit us on ${appointmentDate} at ${slot}</p>
            <p>Thanks from Doctors Portal</p
        </div>
        `, // html body
    }, function (error, info) {
        if (error) {
            console.log('send erroe', error);
        } else {
            console.log('Email sent: ' + info.response);
        }
    });
}

// jwt function -----------------------------------------------
function verifyJWT(req, res, next) {
    // console.log(req.headers.authorization);

    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send('unauthorized access');
    }


    const token = authHeader.split(' ')[1];

    jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'forbidden access' })
        }
        req.decoded = decoded;
        next();
    })
}

async function run() {
    try {
        const appointmentOptionCollection = client.db('doctorsPortal').collection('appointmentOptions');
        const bookingsCollection = client.db('doctorsPortal').collection('bookings');
        const usersCollection = client.db('doctorsPortal').collection('users');
        const doctorsCollection = client.db('doctorsPortal').collection('doctors');
        const paymentsCollection = client.db('doctorsPortal').collection('payments');


        // middleware for jwt "decoded" verification -------------------- [Module-76.8]-------
        const verifyAdmin = async (req, res, next) => {  // NOTE: use this func after "verifyJWT"
            console.log('inside verifyAdmin:', req.decoded.email);
            const decodedEmail = req.decoded.email;
            const query = { email: decodedEmail };
            const user = await usersCollection.findOne(query);

            if (user?.role !== 'admin') {
                return res.status(403).send({ message: 'Forbidden access' })
            }
            next();
        }

        // -----------------------------------------------------------------------------------

        // get all appointmentOptions [Complex]
        // Use aggregate to query multiple collection and then merge data
        app.get('/appointmentOptions', async (req, res) => {
            const date = req.query.date;

            const query = {};
            const options = await appointmentOptionCollection.find(query).toArray();

            // first kon kon date a booking ache seguloke alada kora hoise 
            const bookingQuery = { appointmentDate: date }
            const alreadyBooked = await bookingsCollection.find(bookingQuery).toArray();

            options.forEach(option => {
                const optionBooked = alreadyBooked.filter(book => book.treatment === option.name);
                const bookedSlots = optionBooked.map(book => book.slot);
                const remainingSlots = option.slots.filter(slot => !bookedSlots.includes(slot))
                option.slots = remainingSlots;

                // console.log(option.name, remainingSlots.length);
            })

            res.send(options);
        });


        // ------------------- Advance/different way ----------------------// 
        app.get('/v2/appointmentOptions', async (req, res) => {
            const date = req.query.date;
            const options = await appointmentOptionCollection.aggregate([
                {
                    $lookup: {
                        from: 'bookings',
                        localField: 'name',
                        foreignField: 'treatment',
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $eq: ['$appointmentDate', date]
                                    }
                                }
                            }
                        ],
                        as: 'booked'
                    }
                },
                {
                    $project: {
                        name: 1,
                        slots: 1,
                        price: 1,
                        booked: {
                            $map: {
                                input: '$booked',
                                as: 'book',
                                in: '$$book.slot'
                            }
                        }
                    }
                },
                {
                    $project: {
                        name: 1,
                        price: 1,
                        slots: {
                            $setDifference: ['$slots', '$booked']
                        }
                    }
                }
            ]).toArray();
            res.send(options);
        })
        //-------------------------------------------------------------------


        // get only doctors specialty from "appointmentOptionCollection"--- [Module: 76]
        app.get('/appointmentSpecialty', async (req, res) => {
            const query = {}
            const result = await appointmentOptionCollection.find(query).project({ name: 1 }).toArray();
            res.send(result);
        })


        // get all my appointments ----------------------------
        app.get('/bookings', verifyJWT, async (req, res) => {
            const email = req.query.email;
            // console.log(req.headers.authorization);
            const decodedEmail = req.decoded.email;

            console.log(req.decoded);

            if (email !== decodedEmail) {
                return res.status(403).send({ message: 'forbidden access' });
            }

            const query = { email: email };
            const bookings = await bookingsCollection.find(query).toArray();
            res.send(bookings);
        })

        // get specific booking info for "Payment Activities" [module 77-2]
        app.get('/bookings/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) };
            const booking = await bookingsCollection.findOne(query);
            res.send(booking);
        })

        // post appointment bookings ------------------------
        app.post('/bookings', async (req, res) => {
            const booking = req.body;
            // console.log(booking);

            // check if already booked on that day
            const query = {
                appointmentDate: booking.appointmentDate,
                email: booking.email,
                treatment: booking.treatment
            }

            const alreadyBooked = await bookingsCollection.find(query).toArray();

            if (alreadyBooked.length) {
                const message = `You already have a booking on ${booking.appointmentDate}`
                return res.send({ acknowledged: false, message })
            }

            const result = await bookingsCollection.insertOne(booking);

            // send email about appoint confirmation [Module: 78.5-1]
            sendBookingEmail(booking);
            res.send(result);
        });


        // api for payment gateway -------------------------------------
        app.post('/create-payment-intent', async (req, res) => {
            const booking = req.body;
            const price = booking.price;
            const amount = price * 100;

            const paymentIntent = await stripe.paymentIntents.create({
                currency: 'usd',
                amount: amount,
                "payment_method_types": [
                    "card"
                ]
            });
            res.send({
                clientSecret: paymentIntent.client_secret,
            });
        })

        // get payments info to save in db -----------------------------
        app.post('/payments', async (req, res) => {
            const payment = req.body;
            const result = await paymentsCollection.insertOne(payment);

            // matching id with booking collection and update info to update payment status
            const id = req.body.bookingId;
            const filter = { _id: ObjectId(id) }

            const updatedDoc = {
                $set: {
                    paid: true,
                    transactionId: payment.transactionId
                }
            }
            const updateResult = await bookingsCollection.updateOne(filter, updatedDoc)
            res.send(result);
        })

        // -------------------------------------------------------------


        // generating jwt -----------------------------------------
        app.get('/jwt', async (req, res) => {
            const email = req.query.email;
            const query = { email: email };
            const user = await usersCollection.findOne(query);
            if (user) {
                const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: '1d' })
                return res.send({ accessToken: token });
            }
            res.status(403).send({ accessToken: '' })
        });

        // get all users -------------------------------------------
        app.get('/users', async (req, res) => {
            const query = {}
            const users = await usersCollection.find(query).toArray();
            res.send(users);
        });

        // check if the user is admin --------------------------------
        app.get('/users/admin/:email', async (req, res) => {
            const email = req.params.email; // edited
            const query = { email }  // edited
            const user = await usersCollection.findOne(query);
            res.send({ isAdmin: user?.role === 'admin' });
        })

        // post/create/save all users info in db [Module 75-3]---------------------
        app.post('/users', async (req, res) => {
            const user = req.body;
            const result = await usersCollection.insertOne(user);
            res.send(result);
        });

        // update user role [admin] -------------------------------------
        app.put('/users/admin/:id', verifyJWT, verifyAdmin, async (req, res) => {

            // jwt check
            /* ==> NOTE: Moved to a common function "verifyAdmin"

            const decodedEmail = req.decoded.email;
            const query = { email: decodedEmail };
            const user = await usersCollection.findOne(query);

            if (user?.role !== 'admin') {
                return res.status(403).send({ message: 'Forbidden access' })
            }
            */

            // finally update role
            const id = req.params.id;
            const filter = { _id: ObjectId(id) };

            const options = { upsert: true }
            const updatedDoc = {
                $set: {
                    role: 'admin'
                }
            }
            const result = await usersCollection.updateOne(filter, updatedDoc, options)
            res.send(result);
        });

        // --- Temporary to update price field on appointment options -- [Module: 77-1]---
        /* 
         app.get('/addPrice', async (req, res) => {
             const filter = {}
             const options = { upsert: true };
             const updatedDoc = {
                 $set: {
                     price: 99
                 }
             }
             const result = await appointmentOptionCollection.updateMany(filter, updatedDoc, options)
             res.send(result);
         })
        */
        // ---------------------------------------------------------------------------------


        // get all doctors 
        app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const query = {};
            const doctors = await doctorsCollection.find(query).toArray();
            res.send(doctors);
        });

        // create/post doctors data [module 76-5]
        app.post('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const doctor = req.body;
            const result = await doctorsCollection.insertOne(doctor);
            res.send(result);
        })

        // delete a doctor
        app.delete('/doctors/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: ObjectId(id) };
            const result = await doctorsCollection.deleteOne(filter);
            res.send(result);
        })


    }
    finally {

    }
}
run().catch(console.log);


// ----- API Naming Convention -----//

/**** 
*ex. bookings
*app.get('/bookings')
*app.get('/bookings/:id')
*app.post('/bookings')
*app.patch/put('/bookings/:id')
*app.delete('/bookings/id')
*/

//-------------------
app.get('/', async (req, res) => {
    res.send('doctors portal server is running')
})

app.listen(port, () => console.log(`Doctors portal running on port: ${port}`))